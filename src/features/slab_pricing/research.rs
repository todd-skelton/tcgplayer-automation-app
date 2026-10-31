//! Research for the certificate shown: the evidence saved for a grade (the owned one, or a PSA
//! grade explored beside it) over a window of sale dates, and whether a refresh is on its way,
//! ported from `loadSlabWorkspace`. Refreshing stays the Node app's (`/api/slab-evidence`), whose
//! worker calls eBay and Alt, and whose status read keeps that worker running.
use std::collections::BTreeSet;

use chrono::{Days, NaiveDate, SecondsFormat, Utc};
use chrono_tz::America::Chicago;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::recommendation::Recommendation;
use crate::{
    database::Database,
    features::{
        inventory_economics::ledger::fingerprint::{js_float, js_json, sha256_hex},
        slab_evidence::{
            spec::{self, EbayPage, Spec as Request},
            store,
        },
    },
    legacy::Legacy,
};

/// The PSA grades a slab can be explored at beside its own: every half grade from 1 to 10 but
/// 9.5, which PSA does not give.
pub const PSA_GRADES: [&str; 18] = [
    "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5",
    "9", "10",
];

/// The sale dates evidence is read over, as `YYYY-MM-DD`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Window {
    pub from: String,
    pub to: String,
}

impl Window {
    /// The year up to today in Chicago, where the seller works, as the React screen chose it.
    pub fn last_year() -> Window {
        Window::year_to(Utc::now().with_timezone(&Chicago).date_naive())
    }

    fn year_to(today: NaiveDate) -> Window {
        let from = today.checked_sub_days(Days::new(365)).unwrap_or(today);
        Window {
            from: from.format("%Y-%m-%d").to_string(),
            to: today.format("%Y-%m-%d").to_string(),
        }
    }
}

/// What is saved for a slab's research at one grade and window.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub statuses: Vec<EvidenceStatus>,
    pub keys: Vec<String>,
    /// Why no cross-grade estimate is offered.
    pub grade_model: Option<GradeModel>,
    /// The slab's latest recommendation, whatever grade is researched.
    pub recommendation: Option<Recommendation>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct GradeModel {
    pub reason: String,
}

/// One piece of evidence (eBay sales, Alt sales, supply) and where its refresh stands.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceStatus {
    pub key: String,
    pub spec: Spec,
    /// `queued`, `running`, `idle`, `failed` or `cancelled`.
    pub state: String,
    pub run_id: String,
    /// The saved revision the comps are read from, once one was fetched.
    pub latest_revision: Option<String>,
    pub fetched_at: Option<String>,
    pub error_code: Option<String>,
    /// Expired, never fetched, or failed.
    pub stale: bool,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Spec {
    pub kind: String,
    /// An eBay page's first result and page size.
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

impl EvidenceStatus {
    /// A refresh is queued or running, so the panel reads it again.
    pub fn pending(&self) -> bool {
        matches!(self.state.as_str(), "queued" | "running")
    }
}

impl Workspace {
    pub fn pending(&self) -> bool {
        self.statuses.iter().any(EvidenceStatus::pending)
    }

    /// The evidence revisions saved for the grade and dates: what a calculation reads.
    pub fn latest_revisions(&self) -> BTreeSet<String> {
        self.statuses
            .iter()
            .filter_map(|s| s.latest_revision.clone())
            .collect()
    }
}

/// A slab's card and grade, as saved (`SlabIdentity`).
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity {
    pub(super) card: Card,
    pub(super) grading: Grading,
    #[serde(default)]
    provider_asset: Option<Asset>,
}

/// `CARD_FIELDS`, in their order.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Card {
    pub(super) name: Option<String>,
    pub(super) game: Option<String>,
    pub(super) language: Option<String>,
    pub(super) set: Option<String>,
    pub(super) card_number: Option<String>,
    pub(super) year: Option<String>,
    pub(super) edition: Option<String>,
    pub(super) finish: Option<String>,
    pub(super) stamp: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub(super) struct Grading {
    pub(super) grader: String,
    pub(super) encoding: String,
    pub(super) number: Option<f64>,
    pub(super) label: Option<String>,
    pub(super) qualifier: Option<String>,
    pub(super) autograph: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
struct Asset {
    provider: String,
    id: String,
}

/// JavaScript's `trim`, which also takes the byte order mark.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

impl Identity {
    /// `valuationGroupKey`: what makes two slabs the same for valuation, hashed. No certificate
    /// or listing is part of it.
    fn group_key(&self) -> String {
        let normalized =
            |value: &Option<String>| json!(value.as_deref().map(|v| js_trim(v).to_lowercase()));
        let c = &self.card;
        let g = &self.grading;
        let fields = [
            normalized(&c.name),
            normalized(&c.game),
            normalized(&c.language),
            normalized(&c.set),
            normalized(&c.card_number),
            normalized(&c.year),
            normalized(&c.edition),
            normalized(&c.finish),
            normalized(&c.stamp),
            json!(self.provider_asset.as_ref().map(|a| &a.provider)),
            json!(self.provider_asset.as_ref().map(|a| &a.id)),
            json!(g.grader),
            g.number.map_or_else(|| json!(g.encoding), |n| json!(n)),
            normalized(&g.label),
            normalized(&g.qualifier),
            normalized(&g.autograph),
        ];
        sha256_hex(&js_json(&fields))
    }

    /// `buildResearchKeywords`: the card and grade as an eBay search, PSA's grade without its
    /// label.
    fn keywords(&self) -> String {
        let c = &self.card;
        let g = &self.grading;
        let number = g.number.map_or_else(|| g.encoding.clone(), js_float);
        let label = g.label.as_ref().filter(|_| g.grader != "PSA");
        [
            c.year.as_ref(),
            c.game.as_ref(),
            c.name.as_ref(),
            c.card_number.as_ref(),
            c.set.as_ref(),
            c.language.as_ref(),
            c.edition.as_ref(),
            c.finish.as_ref(),
            c.stamp.as_ref(),
            Some(&g.grader),
            Some(&number),
            label,
            g.qualifier.as_ref(),
            g.autograph.as_ref(),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ")
    }

    /// `researchTarget`: the identity at `grade`, the owned one or a PSA grade explored beside it.
    fn at_grade(self, grade: &str) -> Result<Identity, String> {
        if grade == "owned" {
            return Ok(self);
        }
        let half = |g: &str| match g.split_once('.') {
            Some((whole, "5")) => whole.len() == 1 && matches!(whole.as_bytes()[0], b'1'..=b'9'),
            None => (g.len() == 1 && matches!(g.as_bytes()[0], b'1'..=b'9')) || g == "10",
            _ => false,
        };
        if self.grading.grader != "PSA" || !half(grade) || grade == "9.5" {
            return Err("Choose the owned grade or a supported PSA research grade.".to_owned());
        }
        let number: f64 = grade
            .parse()
            .map_err(|_| "Choose a PSA grade.".to_owned())?;
        Ok(Identity {
            grading: Grading {
                grader: "PSA".to_owned(),
                encoding: grade.to_owned(),
                number: Some(number),
                label: Some(format!("PSA {grade}")),
                qualifier: None,
                autograph: None,
            },
            ..self
        })
    }

    /// `gradeModelStatus`: why no cross-grade estimate is offered.
    fn grade_model(identity: Option<&Identity>) -> GradeModel {
        let psa_one =
            identity.is_some_and(|i| i.grading.grader == "PSA" && i.grading.number == Some(1.0));
        GradeModel {
            reason: if psa_one {
                "PSA 1 collector pricing is not inferred from higher grades. Review its direct sales."
            } else {
                "No cross-grade model has enough verified, time-separated evidence for this cohort. Pricing uses direct sales and your review."
            }
            .to_owned(),
        }
    }

    /// `planSlabEvidence` for one confirmed slab: the keys of [`specs`].
    fn keys(&self, window: &Window) -> Result<Vec<String>, String> {
        specs_checked(self, window)?
            .iter()
            .map(|r| r.key().map_err(|e| e.0))
            .collect()
    }
}

/// What to read for a slab: its Alt sales when Alt knows the card, and its eBay sales.
fn specs_checked(identity: &Identity, window: &Window) -> Result<Vec<Request>, String> {
    let window = spec::Window {
        from: window.from.clone(),
        to: window.to.clone(),
    }
    .checked()
    .map_err(|e| e.0)?;
    let mut requests = Vec::new();
    if let Some(asset) = &identity.provider_asset {
        requests.push(Request::AltSales {
            asset_id: asset.id.clone(),
            window: window.clone(),
            limit_per_grade: 16,
        });
    }
    requests.push(Request::EbaySales(EbayPage {
        group_key: identity.group_key(),
        keywords: identity.keywords(),
        window,
        offset: 0,
        limit: 50,
        timezone: "America/Chicago".to_owned(),
    }));
    Ok(requests)
}

#[cfg(test)]
fn specs(identity: &Identity, window: &Window) -> Vec<Request> {
    specs_checked(identity, window)
        .unwrap()
        .into_iter()
        .map(|r| r.normalized().unwrap())
        .collect()
}

fn status(s: store::Status) -> EvidenceStatus {
    let (offset, limit) = match &s.spec {
        Request::EbaySales(page) | Request::EbaySupply(page) => (
            u32::try_from(page.offset).ok(),
            u32::try_from(page.limit).ok(),
        ),
        _ => (None, None),
    };
    EvidenceStatus {
        spec: Spec {
            kind: s.spec.kind().to_owned(),
            offset,
            limit,
        },
        key: s.key,
        state: s.state,
        run_id: s.run_id,
        latest_revision: s.latest_revision,
        fetched_at: s
            .fetched_at
            .map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true)),
        error_code: s.error_code,
        stale: s.stale,
    }
}

/// The research as read, its recommendation as saved.
#[derive(Debug, PartialEq)]
struct Researched {
    keys: Vec<String>,
    statuses: Vec<EvidenceStatus>,
    grade_model: GradeModel,
    recommendation: Option<Value>,
}

/// `getSlabRecommendation` of the slab's latest: `current` while its identity, decisions and
/// evidence are as it was calculated from.
const LATEST: &str = r#"SELECT jsonb_build_object('id', r.id, 'calculation', r.calculation,
    'current', (i.revision = r.identity_revision AND i.valuation_group_key = r.valuation_group_key AND i.status = 'confirmed'
    AND r.calculation->'decisions' = COALESCE((SELECT jsonb_agg(d.decision ORDER BY d.revision_id,d.event_key) FROM slab_comp_decisions d
      WHERE d.valuation_group_key=r.valuation_group_key AND d.revision_id IN (SELECT revision_id FROM slab_recommendation_evidence WHERE recommendation_id=r.id)), '[]'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM slab_recommendation_evidence e JOIN slab_evidence_revisions v ON v.id=e.revision_id
      JOIN slab_evidence_refreshes j ON j.key=v.key WHERE e.recommendation_id=r.id AND (j.latest_revision IS DISTINCT FROM v.id OR j.expires_at <= clock_timestamp() OR j.expires_at IS NULL OR j.state='failed'))),
    'override', CASE WHEN o.recommendation_id IS NULL THEN NULL ELSE jsonb_build_object('itemPrice',o.item_price,'currency',o.currency,'note',o.note,'reviewedAt',o.reviewed_at) END)
    FROM slab_recommendations r JOIN slab_identities i ON i.id=r.slab_id LEFT JOIN slab_price_overrides o ON o.recommendation_id=r.id
    WHERE r.id = (SELECT id FROM slab_recommendations WHERE slab_id=$1::uuid ORDER BY created_at DESC, id DESC LIMIT 1)"#;

/// A slab as `loadResearchPlan` reads it: its identity at the grade researched, the evidence
/// keys for it over the window, and the slab's own state.
pub(super) struct Plan {
    /// `confirmed` or `needs-review`.
    pub(super) status: String,
    /// The identity's revision: a decision saved over a newer one is refused.
    pub(super) revision: i64,
    pub(super) target: Identity,
    /// The target's valuation group: the slab's saved one at the owned grade, else the grade's.
    pub(super) valuation_group_key: Option<String>,
    keys: Vec<String>,
    grade_model: GradeModel,
}

/// `loadResearchPlan` with `researchTarget`: the slab `id` at `grade` (`owned` or a PSA grade),
/// and the evidence keys for it over `window`.
pub(super) async fn plan(
    conn: &mut PgConnection,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Plan, String> {
    let uuid = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        });
    if !uuid {
        return Err("Choose a saved slab identity.".to_owned());
    }
    type Record = (Option<Value>, Option<Value>, String, i32, Option<String>);
    let record: Option<Record> = sqlx::query_as(
        "SELECT identity, candidate->'identity', status, revision, valuation_group_key FROM slab_identities WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let Some((saved, candidate, status, revision, saved_key)) = record else {
        return Err("The slab identity changed. Reopen it before refreshing.".to_owned());
    };
    let identity = |value: Option<Value>| {
        value
            .filter(|v| !v.is_null())
            .map(serde_json::from_value::<Identity>)
            .transpose()
            .map_err(|e| e.to_string())
    };
    let source = match identity(saved)? {
        Some(owned) => Some(owned),
        None => identity(candidate)?,
    };
    let grade_model = Identity::grade_model(source.as_ref());
    let Some(source) = source else {
        return Err("Correct the card identity before researching it.".to_owned());
    };
    let target = source.at_grade(grade)?;
    let keys = target.keys(window)?;
    let valuation_group_key = if grade == "owned" {
        saved_key
    } else {
        Some(target.group_key())
    };
    Ok(Plan {
        status,
        revision: i64::from(revision),
        target,
        valuation_group_key,
        keys,
        grade_model,
    })
}

/// `loadSlabWorkspace`: the slab's evidence keys at `grade` over `window`, where their
/// refreshes stand, and its latest recommendation.
async fn research(
    conn: &mut PgConnection,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Researched, String> {
    let Plan {
        keys, grade_model, ..
    } = plan(conn, id, grade, window).await?;
    let statuses = store::statuses(&mut *conn, &keys)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(status)
        .collect();
    let recommendation: Option<Value> = sqlx::query_scalar(LATEST)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Researched {
        keys,
        statuses,
        grade_model,
        recommendation,
    })
}

/// The slab's research at `grade` (`owned` or a PSA grade) over `window`.
pub async fn read(
    db: &Database,
    id: &str,
    grade: &str,
    window: &Window,
) -> Result<Workspace, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    let researched = research(&mut conn, id, grade, window).await?;
    Ok(Workspace {
        statuses: researched.statuses,
        keys: researched.keys,
        grade_model: Some(researched.grade_model),
        recommendation: researched
            .recommendation
            .map(serde_json::from_value)
            .transpose()
            .map_err(|e| format!("The slab's recommendation could not be read: {e}"))?,
    })
}

#[derive(Deserialize)]
struct Statuses {
    statuses: Vec<EvidenceStatus>,
}

/// Where the refreshes of `keys` stand. Asking keeps the Node app's refresh worker running
/// while one is queued, as the React screen's poll did.
pub async fn statuses(legacy: &Legacy, keys: &[String]) -> Result<Vec<EvidenceStatus>, String> {
    #[derive(Serialize)]
    struct Keys {
        keys: String,
    }
    let keys = Keys {
        keys: keys.join(","),
    };
    legacy
        .read_with::<Statuses, _>("/api/slab-evidence", &keys)
        .await
        .map(|s| s.statuses)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases in `.port-logs/slab-workspace-cases.json` on the slabs `slab-workspace-seed.sql`
    /// saves, in a transaction rolled back, against Node's `loadSlabWorkspace`
    /// (`.port-logs/slab-workspace-node.ts`): before any refresh is saved, and after the first
    /// case's two are (one fetched and fresh, one queued).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's reads in .port-logs"]
    async fn workspaces_read_as_node_reads_them() {
        #[derive(Deserialize)]
        struct Case {
            id: String,
            grade: String,
            from: String,
            to: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Theirs {
            error: Option<String>,
            #[serde(default)]
            keys: Vec<String>,
            #[serde(default)]
            statuses: Vec<EvidenceStatus>,
            grade_model: Option<GradeModel>,
            #[serde(default)]
            recommendation: Option<Value>,
        }
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Case> = serde_json::from_str(&read("slab-workspace-cases.json")).unwrap();
        let node: Value = serde_json::from_str(&read("slab-workspace.node.json")).unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read("slab-workspace-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for pass in ["before", "after"] {
            let theirs: Vec<Theirs> = serde_json::from_value(node[pass].clone()).unwrap();
            for (case, theirs) in cases.iter().zip(theirs) {
                let window = Window {
                    from: case.from.clone(),
                    to: case.to.clone(),
                };
                let ours = research(&mut tx, &case.id, &case.grade, &window).await;
                let theirs = match theirs.error {
                    Some(error) => Err(error),
                    None => Ok(Researched {
                        keys: theirs.keys,
                        statuses: theirs.statuses,
                        grade_model: theirs.grade_model.unwrap(),
                        recommendation: theirs.recommendation,
                    }),
                };
                assert_eq!(ours, theirs, "{pass} {} at {}", case.id, case.grade);
            }
            if pass == "before" {
                let first = &cases[0];
                let window = Window {
                    from: first.from.clone(),
                    to: first.to.clone(),
                };
                let keys = research(&mut tx, &first.id, &first.grade, &window)
                    .await
                    .unwrap()
                    .keys;
                let identity: Identity = serde_json::from_value(
                    sqlx::query_scalar("SELECT identity FROM slab_identities WHERE id = $1::uuid")
                        .bind(&first.id)
                        .fetch_one(&mut *tx)
                        .await
                        .unwrap(),
                )
                .unwrap();
                let specs = specs(&identity, &window);
                sqlx::query(
                    "INSERT INTO slab_evidence_refreshes (key, spec, state, run_id, fetched_at, expires_at, error_code)
                    VALUES ($1, $2, 'idle', 'c0000000-0000-4000-8000-000000000001', '2026-10-30T01:02:03.456Z', '2099-01-01T00:00:00Z', NULL),
                           ($3, $4, 'queued', 'c0000000-0000-4000-8000-000000000002', NULL, NULL, 'timeout')",
                )
                .bind(&keys[0])
                .bind(serde_json::to_value(&specs[0]).unwrap())
                .bind(&keys[1])
                .bind(serde_json::to_value(&specs[1]).unwrap())
                .execute(&mut *tx)
                .await
                .unwrap();
            }
        }
        tx.rollback().await.unwrap();
    }

    #[test]
    fn the_default_window_is_the_year_to_today() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        assert_eq!(
            Window::year_to(today),
            Window {
                from: "2025-10-30".into(),
                to: "2026-10-30".into()
            }
        );
    }

    #[test]
    fn a_queued_or_running_refresh_is_pending() {
        let status = |state: &str| -> EvidenceStatus {
            serde_json::from_value(serde_json::json!({
                "key": "k", "spec": { "kind": "ebay-sales" }, "state": state, "runId": "r",
                "latestRevision": null, "fetchedAt": null, "errorCode": null, "stale": true
            }))
            .unwrap()
        };
        assert!(status("queued").pending());
        assert!(status("running").pending());
        assert!(!status("failed").pending());
    }
}
