//! Reviewing a listing's price change: a preview saved with the listing and its evidence, then a
//! dry run of its publication against the imported inventory. The preview, its conflicts, its
//! runs and their steps are read here; preparing a preview and running it stay the Node app's
//! (`/api/slab-publication-previews`, `/api/slab-publications`), and neither contacts eBay:
//! seller OAuth and live readback are not connected, so nothing publishes.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;

use super::{
    inventory::{self, Listing},
    recommendation,
};
use crate::database::Database;

/// A saved price-change preview, and why it would need replacing now.
#[derive(Clone, Debug, Deserialize)]
pub struct Preview {
    pub id: String,
    pub plan: Plan,
    pub conflicts: Vec<String>,
}

/// The price change as it was saved: the listing, the old and new item price, and what it rests on.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub inventory: PlanInventory,
    pub recommendation_id: String,
    pub old_price: Amount,
    pub new_price: Amount,
    pub change_percent: f64,
    /// `calculated` or `reviewed`.
    pub selection: String,
    pub identity: PlanIdentity,
    pub created_at: String,
    pub expires_at: String,
    pub evidence: Vec<serde_json::Value>,
    pub r#override: Option<PlanOverride>,
    pub flags: Vec<String>,
    pub policy_version: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInventory {
    pub id: String,
    pub item_id: String,
    #[serde(default)]
    pub variation_key: String,
    pub seller: String,
    pub revision: i64,
    pub snapshot: PlanSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlanSnapshot {
    pub title: String,
    pub quantity: i64,
    pub format: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Amount {
    pub amount: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIdentity {
    pub slab_id: Option<String>,
    pub revision: i64,
}

/// The reviewed ask the preview was prepared from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOverride {
    pub item_price: Option<f64>,
    pub currency: Option<String>,
    pub note: String,
    pub reviewed_at: Option<String>,
}

impl Plan {
    /// Its review time is over (Node's `preview-expired` conflict says the same when read).
    pub fn expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .parse::<DateTime<Utc>>()
            .map_or(true, |at| at <= now)
    }

    /// `+12.5%` or `-3.0%`.
    pub fn change(&self) -> String {
        let sign = if self.change_percent > 0.0 { "+" } else { "" };
        format!("{sign}{:.1}%", self.change_percent)
    }
}

/// One publication of a preview: its mode (`dry-run` or `live`), where it stands and why.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub state: String,
    pub reason: Option<String>,
    pub mode: String,
    pub created_at: String,
}

impl Run {
    /// A dry run stopped before it finished, which the same intent picks up again.
    pub fn resumable(&self) -> bool {
        self.mode == "dry-run" && matches!(self.state.as_str(), "approved" | "checking")
    }
}

/// A step a publication recorded, latest first.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub state: String,
    pub reason: Option<String>,
    pub created_at: String,
}

/// The listing's latest preview, its last publications, and the steps of the one asked about.
#[derive(Clone, Debug, Default)]
pub struct Review {
    pub preview: Option<Preview>,
    pub runs: Vec<Run>,
    /// The publication whose steps are shown, when it is one of this preview's.
    pub steps: Option<(String, Vec<Step>)>,
}

/// The most publications listed, as the React panel showed.
const MOST_RUNS: i64 = 5;

/// The publication policy previews are prepared under (`SLAB_PUBLICATION_POLICY`).
const POLICY: &str = "reviewed-price-v1";

/// What a preview's conflicts read of its recommendation as it stands.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    current: bool,
    calculation: StoredCalculation,
    r#override: Option<StoredOverride>,
}

#[derive(Deserialize)]
struct StoredCalculation {
    identity: PlanIdentityRevision,
}

#[derive(Deserialize)]
struct PlanIdentityRevision {
    revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOverride {
    item_price: f64,
    currency: String,
    note: String,
    reviewed_at: String,
}

fn time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

/// `previewConflicts`: why the saved preview no longer matches the listing, its recommendation or
/// the reviewed ask, as of `now`.
fn conflicts(
    plan: &Plan,
    inventory: Option<&Listing>,
    recommendation: Option<&Stored>,
    now: DateTime<Utc>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let before = time(&plan.created_at).is_some_and(|at| now < at);
    let after = time(&plan.expires_at).is_some_and(|at| now >= at);
    if before || after {
        reasons.push("preview-expired");
    }
    if plan.version != POLICY {
        reasons.push("publication-policy-changed");
    }
    let saved = &plan.inventory;
    let listing_matches = inventory.is_some_and(|l| {
        l.id == saved.id
            && l.revision == saved.revision
            && l.seller == saved.seller
            && l.item_id == saved.item_id
            && l.variation_key == saved.variation_key
            && l.identity_id == plan.identity.slab_id
            && l.state == "active"
            && l.review_reasons.iter().all(|r| r == "certificate-required")
    });
    if !listing_matches {
        reasons.push("inventory-changed");
    }
    let recommendation_matches = recommendation.is_some_and(|r| {
        r.id == plan.recommendation_id
            && r.current
            && r.calculation.identity.revision == plan.identity.revision
    });
    if !recommendation_matches {
        reasons.push("recommendation-changed");
    }
    if plan.selection == "reviewed" {
        let reviewed = recommendation.and_then(|r| r.r#override.as_ref());
        let same = match (reviewed, &plan.r#override) {
            (Some(now), Some(then)) => {
                then.item_price == Some(now.item_price)
                    && then.currency.as_deref() == Some(now.currency.as_str())
                    && then.note == now.note
                    && then.reviewed_at.as_deref() == Some(now.reviewed_at.as_str())
            }
            _ => false,
        };
        if !same {
            reasons.push("reviewed-ask-changed");
        }
    }
    reasons.into_iter().map(str::to_owned).collect()
}

fn is_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// `readPublicationPreview` of a listing: its latest preview, and why it would need replacing.
async fn preview(
    conn: &mut PgConnection,
    listing: &str,
    now: DateTime<Utc>,
) -> Result<Option<Preview>, String> {
    let failed = |e: sqlx::Error| e.to_string();
    if !is_id(listing) {
        return Err("Choose a saved preview or listing.".to_owned());
    }
    let row: Option<(String, Value)> = sqlx::query_as(
        "SELECT id::text, plan FROM slab_publication_previews WHERE inventory_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .bind(listing)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    let Some((id, plan)) = row else {
        return Ok(None);
    };
    let plan: Plan = serde_json::from_value(plan)
        .map_err(|e| format!("The saved preview could not be read: {e}"))?;
    let inventory = inventory::listing(conn, &plan.inventory.id).await?;
    if !is_id(&plan.recommendation_id) {
        return Err("Choose a recommendation.".to_owned());
    }
    let stored: Option<Value> = sqlx::query_scalar(recommendation::BY_ID)
        .bind(&plan.recommendation_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
    let stored: Option<Stored> = stored
        .map(serde_json::from_value)
        .transpose()
        .map_err(|e| format!("The preview's recommendation could not be read: {e}"))?;
    Ok(Some(Preview {
        conflicts: conflicts(&plan, inventory.as_ref(), stored.as_ref(), now),
        id,
        plan,
    }))
}

/// A publication as listed: its id, state, why, mode and when it was prepared.
type RunRow = (String, String, Option<String>, String, DateTime<Utc>);

/// The preview's latest publications (`publicationHistory`).
async fn runs(conn: &mut PgConnection, preview: &str) -> Result<Vec<Run>, String> {
    let rows: Vec<RunRow> = sqlx::query_as(
        "SELECT id::text, state, reason, mode, created_at FROM slab_publications WHERE preview_id = $1::uuid ORDER BY created_at DESC, id DESC LIMIT $2",
    )
    .bind(preview)
    .bind(MOST_RUNS)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, state, reason, mode, at)| Run {
            id,
            state,
            reason,
            mode,
            created_at: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .collect())
}

/// A publication's steps, latest first (`publicationEvents`).
async fn steps_of(conn: &mut PgConnection, publication: &str) -> Result<Vec<Step>, String> {
    let rows: Vec<(String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT state, reason, created_at FROM slab_publication_events WHERE publication_id = $1::uuid ORDER BY sequence DESC LIMIT 50",
    )
    .bind(publication)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(state, reason, at)| Step {
            state,
            reason,
            created_at: at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
        .collect())
}

async fn review(
    conn: &mut PgConnection,
    listing: &str,
    steps: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Review, String> {
    let Some(preview) = preview(conn, listing, now).await? else {
        return Ok(Review::default());
    };
    let runs = runs(conn, &preview.id).await?;
    let steps = match steps.filter(|id| runs.iter().any(|r| r.id == *id)) {
        Some(id) => Some((id.to_owned(), steps_of(conn, id).await?)),
        None => None,
    };
    Ok(Review {
        preview: Some(preview),
        runs,
        steps,
    })
}

/// The listing's price-change review, with the steps of `steps` when it is one of its runs.
pub async fn read(db: &Database, listing: &str, steps: Option<&str>) -> Result<Review, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    review(&mut conn, listing, steps, Utc::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(change: f64, expires: &str) -> Plan {
        serde_json::from_value(serde_json::json!({
            "recommendationId": "r", "inventory": { "id": "i", "itemId": "1", "seller": "s", "revision": 2,
                "snapshot": { "title": "t", "quantity": 1, "format": "fixed-price" } },
            "oldPrice": { "amount": 100.0 }, "newPrice": { "amount": 112.5 },
            "changePercent": change, "selection": "calculated", "identity": { "slabId": "s", "revision": 1 },
            "createdAt": "2026-10-30T00:00:00Z", "expiresAt": expires, "evidence": [{}],
            "override": null, "flags": [], "policyVersion": "slab-policy-v1",
            "version": "reviewed-price-v1"
        }))
        .unwrap()
    }

    /// The listings in `.port-logs/slab-publication-cases.json`, on the previews and publications
    /// `slab-publication-seed.sql` saves, in a transaction rolled back, against Node's
    /// `readPublicationPreview`, `publicationHistory` and `publicationEvents`
    /// (`.port-logs/slab-publication-node.ts`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn reviews_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<String> =
            serde_json::from_str(&read_log("slab-publication-cases.json")).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log("slab-publication.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("slab-publication-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (listing, theirs) in cases.iter().zip(node) {
            let first_run = theirs["steps"]["id"].as_str();
            let ours = review(&mut tx, listing, first_run, Utc::now()).await;
            let ours = match ours {
                Err(error) => {
                    assert_eq!(Some(error.as_str()), theirs["error"].as_str(), "{listing}");
                    continue;
                }
                Ok(ours) => ours,
            };
            let Some(preview) = &ours.preview else {
                assert!(theirs["preview"].is_null(), "{listing}");
                continue;
            };
            assert_eq!(preview.id, theirs["preview"]["id"], "{listing}");
            let conflicts: Vec<String> =
                serde_json::from_value(theirs["preview"]["conflicts"].clone()).unwrap();
            assert_eq!(preview.conflicts, conflicts, "{listing}");
            let runs: Vec<(String, String, Option<String>, String, String)> = theirs["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let text = |k: &str| r[k].as_str().unwrap().to_owned();
                    (
                        text("id"),
                        text("state"),
                        r["reason"].as_str().map(str::to_owned),
                        text("mode"),
                        text("createdAt"),
                    )
                })
                .collect();
            let ours_runs: Vec<_> = ours
                .runs
                .iter()
                .map(|r| {
                    (
                        r.id.clone(),
                        r.state.clone(),
                        r.reason.clone(),
                        r.mode.clone(),
                        r.created_at.clone(),
                    )
                })
                .collect();
            assert_eq!(ours_runs, runs, "{listing}");
            let steps: Vec<(String, Option<String>, String)> = theirs["steps"]["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    (
                        s["state"].as_str().unwrap().to_owned(),
                        s["reason"].as_str().map(str::to_owned),
                        s["createdAt"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            let ours_steps: Vec<_> = ours
                .steps
                .map(|(_, steps)| {
                    steps
                        .into_iter()
                        .map(|s| (s.state, s.reason, s.created_at))
                        .collect()
                })
                .unwrap_or_default();
            assert_eq!(ours_steps, steps, "{listing}");
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn a_plan_expires_at_its_time() {
        let now: DateTime<Utc> = "2026-10-30T00:10:00Z".parse().unwrap();
        assert!(!plan(1.0, "2026-10-30T00:15:00Z").expired(now));
        assert!(plan(1.0, "2026-10-30T00:10:00Z").expired(now));
        assert!(plan(1.0, "not a date").expired(now));
    }

    #[test]
    fn a_change_is_signed_as_the_react_panel_wrote_it() {
        assert_eq!(plan(12.5, "").change(), "+12.5%");
        assert_eq!(plan(-3.0, "").change(), "-3.0%");
        assert_eq!(plan(0.0, "").change(), "0.0%");
    }

    #[test]
    fn only_a_stopped_dry_run_resumes() {
        let run = |mode: &str, state: &str| Run {
            id: "r".into(),
            state: state.into(),
            reason: None,
            mode: mode.into(),
            created_at: String::new(),
        };
        assert!(run("dry-run", "checking").resumable());
        assert!(run("dry-run", "approved").resumable());
        assert!(!run("dry-run", "dry-run").resumable());
        assert!(!run("live", "checking").resumable());
    }
}
