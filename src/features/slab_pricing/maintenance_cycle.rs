//! The slab maintenance cycle (`runSlabMaintenanceCycle` with `slabMaintenanceStore.server.ts`):
//! a seller whose maintenance is enabled and due is leased for 90 seconds, and a batch of their
//! active listings due a check is checked. A listing whose confirmed identity is a single
//! fixed-price item has its evidence queued for refresh (the selected evidence of its latest
//! recommendation over the rolling year, and what research would read), within the cycle's
//! budget and only from providers connected; once the selected evidence is fresh, the
//! recommendation is calculated again with the listing's ask and shipping, unless a reviewed price
//! holds it or nothing changed. Nothing is published, and no provider is called here: the
//! refreshes are the evidence worker's.
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::America::Chicago;
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;

use super::{
    calculation::{self, Asked},
    inventory::{self, Listing},
    recommendation,
    research::{self, Identity, Window},
    valuation::{Policy, Seller},
};
use crate::features::{
    inventory_economics::ledger::fingerprint::{js_json, jsonb_json, sha256_hex},
    slab_evidence::{
        spec::Spec,
        store::{self, Status},
    },
};

/// What a cycle did, as saved with the seller's settings.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub checked: u32,
    pub queued: u32,
    pub requested: u32,
    pub recalculated: u32,
    pub held: u32,
    pub waiting: u32,
    pub refresh_budget: i32,
}

/// A seller's maintenance, leased to this cycle.
#[derive(sqlx::FromRow)]
struct Job {
    seller: String,
    include_supply: bool,
    interval_minutes: i32,
    batch_size: i32,
    refresh_budget: i32,
    revision: i32,
    lease_id: String,
}

/// What one listing's check found, as saved.
struct Checked {
    input_key: Option<String>,
    recommendation_id: Option<String>,
    outcome: &'static str,
    reason: &'static str,
    waiting: bool,
}

/// The providers whose connections are configured and usable, even if busy for now.
const USABLE: &str = "('connected','busy','rate-limited','unavailable')";

/// `maintenanceWindow`: the rolling year to today in Chicago, as the review page reads it.
pub fn window(now: DateTime<Utc>) -> Window {
    Window::year_to(now.with_timezone(&Chicago).date_naive())
}

fn provider(spec: &Spec) -> &'static str {
    if spec.is_alt() { "alt" } else { "ebayResearch" }
}

/// `claimMaintenance`: the seller due first, leased for 90 seconds.
async fn claim(conn: &mut PgConnection) -> Result<Option<Job>, sqlx::Error> {
    sqlx::query_as(
        "UPDATE slab_maintenance_settings SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds'
         WHERE seller=(SELECT seller FROM slab_maintenance_settings WHERE enabled AND next_cycle_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
           ORDER BY next_cycle_at,seller FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING seller,include_supply,interval_minutes,batch_size,refresh_budget,revision,lease_id::text AS lease_id",
    )
    .fetch_optional(&mut *conn)
    .await
}

/// `maintenanceActive`: whether the cycle still holds the seller's lease, at the settings it read.
async fn active(conn: &mut PgConnection, job: &Job) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM slab_maintenance_settings WHERE seller=$1 AND enabled AND revision=$2 AND lease_id=$3::uuid AND lease_until>clock_timestamp())",
    )
    .bind(&job.seller)
    .bind(job.revision)
    .bind(&job.lease_id)
    .fetch_one(&mut *conn)
    .await
}

/// `maintenanceCandidates`: the seller's active listings never checked, or changed since, first;
/// then those due, or whose latest recommendation is not the one checked, the oldest checked first.
async fn candidates(conn: &mut PgConnection, job: &Job) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT i.id::text FROM slab_inventory i LEFT JOIN slab_identities d ON d.id=i.identity_id LEFT JOIN slab_maintenance_items m ON m.inventory_id=i.id
         WHERE i.seller=$1 AND i.state='active' AND (m.inventory_id IS NULL OR m.inventory_revision<>i.revision OR m.identity_revision IS DISTINCT FROM d.revision OR m.settings_revision<>$2 OR m.next_check_at<=clock_timestamp()
           OR m.recommendation_id IS DISTINCT FROM (SELECT r.id FROM slab_recommendations r WHERE r.slab_id=i.identity_id ORDER BY r.created_at DESC,r.id DESC LIMIT 1))
         ORDER BY (m.inventory_id IS NULL OR m.inventory_revision<>i.revision OR m.identity_revision IS DISTINCT FROM d.revision) DESC,m.checked_at NULLS FIRST,i.id LIMIT $3",
    )
    .bind(&job.seller)
    .bind(job.revision)
    .bind(i64::from(job.batch_size))
    .fetch_all(&mut *conn)
    .await
}

/// `maintenanceCheckpoint`: the listing's check saved while the lease holds, due again in 30
/// seconds while it waits on evidence, else after the seller's interval.
async fn checkpoint(
    conn: &mut PgConnection,
    job: &Job,
    listing: &Listing,
    checked: &Checked,
) -> Result<(), sqlx::Error> {
    let seconds = if checked.waiting {
        30
    } else {
        job.interval_minutes * 60
    };
    sqlx::query(
        "INSERT INTO slab_maintenance_items(inventory_id,inventory_revision,identity_revision,input_key,recommendation_id,outcome,reason,next_check_at,settings_revision)
         SELECT $1::uuid,$2,$3,$4,$5::uuid,$6,$7,clock_timestamp()+$8*interval '1 second',$9 WHERE EXISTS(SELECT 1 FROM slab_maintenance_settings WHERE seller=$10 AND enabled AND revision=$9 AND lease_id=$11::uuid AND lease_until>clock_timestamp())
         ON CONFLICT(inventory_id) DO UPDATE SET inventory_revision=EXCLUDED.inventory_revision,identity_revision=EXCLUDED.identity_revision,input_key=EXCLUDED.input_key,
           recommendation_id=EXCLUDED.recommendation_id,outcome=EXCLUDED.outcome,reason=EXCLUDED.reason,checked_at=clock_timestamp(),next_check_at=EXCLUDED.next_check_at,settings_revision=EXCLUDED.settings_revision",
    )
    .bind(&listing.id)
    .bind(listing.revision as i32)
    .bind(listing.identity.as_ref().map(|i| i.revision as i32))
    .bind(&checked.input_key)
    .bind(&checked.recommendation_id)
    .bind(checked.outcome)
    .bind(checked.reason)
    .bind(f64::from(seconds))
    .bind(job.revision)
    .bind(&job.seller)
    .bind(&job.lease_id)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// `finishMaintenance`: the cycle's summary and error saved, the lease let go, and the next
/// cycle due in 30 seconds.
async fn finish(
    conn: &mut PgConnection,
    job: &Job,
    summary: &Summary,
    error: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE slab_maintenance_settings SET last_cycle_at=clock_timestamp(),last_error=$4,last_summary=$5::jsonb,next_cycle_at=clock_timestamp()+interval '30 seconds',lease_id=NULL,lease_until=NULL
         WHERE seller=$1 AND revision=$2 AND lease_id=$3::uuid AND lease_until>clock_timestamp()",
    )
    .bind(&job.seller)
    .bind(job.revision)
    .bind(&job.lease_id)
    .bind(error)
    .bind(js_json(summary))
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// `runSlabMaintenanceCycle` at `now`: one due seller's cycle, and what it did; none when no
/// seller is due.
pub async fn run(
    conn: &mut PgConnection,
    now: DateTime<Utc>,
) -> Result<Option<Summary>, sqlx::Error> {
    let Some(job) = claim(conn).await? else {
        return Ok(None);
    };
    let mut summary = Summary {
        refresh_budget: job.refresh_budget,
        ..Summary::default()
    };
    let error = match cycle(conn, &job, now, &mut summary).await {
        Ok(()) => None,
        Err(why) => {
            tracing::error!("Slab maintenance for {} unavailable: {why}", job.seller);
            Some("maintenance-unavailable")
        }
    };
    finish(conn, &job, &summary, error).await?;
    Ok(Some(summary))
}

async fn cycle(
    conn: &mut PgConnection,
    job: &Job,
    now: DateTime<Utc>,
    summary: &mut Summary,
) -> Result<(), String> {
    let failed = |e: sqlx::Error| e.to_string();
    let available: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT provider FROM slab_provider_connections WHERE credential <> '' AND status IN {USABLE}"
    ))
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    let window = window(now);
    for id in candidates(conn, job).await.map_err(failed)? {
        if !active(conn, job).await.map_err(failed)? {
            break;
        }
        let Some(listing) = inventory::listing(conn, &id).await? else {
            continue;
        };
        if listing.state != "active" {
            continue;
        }
        let previous: Option<(Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT input_key, recommendation_id::text FROM slab_maintenance_items WHERE inventory_id=$1::uuid",
        )
        .bind(&listing.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
        let (previous_key, previous_recommendation) = previous.unwrap_or_default();
        let mut checked = Checked {
            input_key: None,
            recommendation_id: previous_recommendation,
            outcome: "review-required",
            reason: "confirm-listing-identity",
            waiting: false,
        };
        let check = Check {
            job,
            listing: &listing,
            previous_key: previous_key.as_deref(),
            available: &available,
            window: &window,
            now,
        };
        if let Err(why) = check.run(conn, summary, &mut checked).await {
            tracing::error!("Slab maintenance of listing {}: {why}", listing.id);
            checked.outcome = "review-required";
            checked.reason = "recalculation-unavailable";
        }
        if !active(conn, job).await.map_err(failed)? {
            break;
        }
        checkpoint(conn, job, &listing, &checked)
            .await
            .map_err(failed)?;
        summary.checked += 1;
        if checked.outcome == "review-required" {
            summary.held += 1;
        }
        if checked.waiting {
            summary.waiting += 1;
        }
    }
    Ok(())
}

/// One listing's check in a cycle.
struct Check<'a> {
    job: &'a Job,
    listing: &'a Listing,
    previous_key: Option<&'a str>,
    available: &'a [String],
    window: &'a Window,
    now: DateTime<Utc>,
}

impl Check<'_> {
    fn usable(&self, spec: &Spec) -> bool {
        self.available.iter().any(|p| p == provider(spec))
    }

    /// What the check found, into `checked` as it goes, so a failure keeps what was found.
    async fn run(
        &self,
        conn: &mut PgConnection,
        summary: &mut Summary,
        checked: &mut Checked,
    ) -> Result<(), String> {
        let failed = |e: sqlx::Error| e.to_string();
        let listing = self.listing;
        let Some(identity) = listing.identity.as_ref() else {
            return Ok(());
        };
        let single = identity.status == "confirmed"
            && identity.identity.is_some()
            && listing
                .review_reasons
                .iter()
                .all(|r| r == "certificate-required")
            && listing.snapshot.quantity == Some(1.0)
            && listing.snapshot.format.as_deref() == Some("fixed-price")
            && listing.variation_key.is_empty();
        if !single {
            return Ok(());
        }
        let latest: Option<String> = sqlx::query_scalar(
            "SELECT id::text FROM slab_recommendations WHERE slab_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 1",
        )
        .bind(&identity.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?;
        let stored: Option<Value> = match &latest {
            Some(id) => sqlx::query_scalar(recommendation::BY_ID)
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(failed)?,
            None => None,
        };
        checked.recommendation_id = stored
            .as_ref()
            .and_then(|r| r["id"].as_str())
            .map(str::to_owned);
        let saved: Option<Value> =
            sqlx::query_scalar("SELECT identity FROM slab_identities WHERE id=$1::uuid")
                .bind(&identity.id)
                .fetch_one(&mut *conn)
                .await
                .map_err(failed)?;
        let card: Identity = serde_json::from_value(saved.unwrap_or_default())
            .map_err(|e| format!("the identity could not be read: {e}"))?;
        let group = identity.valuation_group_key.clone().unwrap_or_default();
        let planned = if group.is_empty() {
            Vec::new()
        } else {
            research::planned(&card, &group, self.window, self.job.include_supply)?
        };
        // The selected evidence of the recommendation, its sales over the rolling year.
        let mut selected: Vec<(String, Spec)> = Vec::new();
        for used in stored
            .as_ref()
            .and_then(|r| r["calculation"]["evidence"].as_array())
            .into_iter()
            .flatten()
        {
            let mut spec: Spec = serde_json::from_value(used["spec"].clone())
                .map_err(|e| format!("a selected evidence request could not be read: {e}"))?;
            let rolled = research::to_spec_window(self.window);
            match &mut spec {
                Spec::AltSales { window, .. } => *window = rolled,
                Spec::EbaySales(page) => page.window = rolled,
                _ => {}
            }
            let spec = spec.normalized().map_err(|e| e.0)?;
            selected.push((spec.key().map_err(|e| e.0)?, spec));
        }
        let mut specs: Vec<(String, Spec)> = Vec::new();
        for (key, spec) in selected.iter().cloned().chain(planned) {
            match specs.iter_mut().find(|(k, _)| *k == key) {
                Some(entry) => entry.1 = spec,
                None => specs.push((key, spec)),
            }
        }
        let keys: Vec<String> = specs.iter().map(|(k, _)| k.clone()).collect();
        let mut by_key: Vec<Status> = store::statuses(&mut *conn, &keys)
            .await
            .map_err(|e| e.to_string())?;
        let status = |by_key: &[Status], key: &str| by_key.iter().position(|s| s.key == key);
        let mut requested: Vec<Spec> = Vec::new();
        for (key, spec) in &specs {
            if requested.len() as i64 + i64::from(summary.requested)
                >= i64::from(self.job.refresh_budget)
            {
                break;
            }
            let state = status(&by_key, key).map(|at| &by_key[at]);
            let due = state.is_none_or(|s| s.stale)
                && state.is_none_or(|s| s.state != "queued" && s.state != "running");
            if self.usable(spec) && due {
                requested.push(spec.clone());
            }
        }
        if !requested.is_empty() && active(conn, self.job).await.map_err(failed)? {
            let refreshed = store::request(&mut *conn, &requested, false, 0)
                .await
                .map_err(|e| e.to_string())?;
            summary.requested += requested.len() as u32;
            summary.queued += refreshed.iter().filter(|s| s.state == "queued").count() as u32;
            for fresh in refreshed {
                match status(&by_key, &fresh.key) {
                    Some(at) => by_key[at] = fresh,
                    None => by_key.push(fresh),
                }
            }
        }
        let chosen: Vec<Option<&Status>> = selected
            .iter()
            .map(|(key, _)| status(&by_key, key).map(|at| &by_key[at]))
            .collect();
        let ready = !chosen.is_empty()
            && chosen.iter().all(|s| {
                s.is_some_and(|s| s.latest_revision.is_some() && !s.stale && s.state == "idle")
            });
        let snapshot = &listing.snapshot;
        match &stored {
            None => checked.reason = "save-seller-context-before-repricing",
            Some(stored) if !stored["override"].is_null() => checked.reason = "reviewed-price-held",
            Some(_) if !ready => {
                checked.outcome = "waiting";
                checked.reason = "fresh-selected-evidence-required";
                checked.waiting = true;
            }
            Some(_)
                if snapshot.price.currency != "USD"
                    || (snapshot.shipping.amount.is_some()
                        && snapshot.shipping.currency.as_deref() != Some("USD")) =>
            {
                checked.reason = "pricing-currency-unresolved";
            }
            Some(stored) => {
                let calculation = &stored["calculation"];
                let mut seller = calculation["seller"].clone();
                seller["currentAsk"] = snapshot.price.amount.into();
                seller["shippingCharged"] = snapshot.shipping.amount.into();
                let mut revision_ids: Vec<String> = chosen
                    .iter()
                    .filter_map(|s| s.and_then(|s| s.latest_revision.clone()))
                    .collect();
                revision_ids.sort();
                revision_ids.dedup();
                // Values read from JSONB are written in JSONB's key order, as Node writes what it read.
                let key = sha256_hex(&format!(
                    "[{},{},{},{},{}]",
                    listing.revision,
                    identity.revision,
                    js_json(&revision_ids),
                    jsonb_json(&calculation["policy"]),
                    jsonb_json(&seller),
                ));
                checked.input_key = Some(key.clone());
                if self.previous_key == Some(key.as_str()) && stored["current"] == true {
                    checked.outcome = "unchanged";
                    checked.reason = "fresh-inputs-unchanged";
                } else if active(conn, self.job).await.map_err(failed)? {
                    let unreadable =
                        |e: serde_json::Error| format!("the recommendation could not be read: {e}");
                    let policy: Policy = serde_json::from_value(calculation["policy"].clone())
                        .map_err(unreadable)?;
                    let seller: Seller = serde_json::from_value(seller).map_err(unreadable)?;
                    let replacing = stored["id"].as_str().unwrap_or_default();
                    let asked = Asked {
                        slab_id: &identity.id,
                        identity_revision: identity.revision,
                        revision_ids: &revision_ids,
                        policy: &policy,
                        seller: &seller,
                        replacing: Some(replacing),
                    };
                    let as_of = self.now.to_rfc3339_opts(SecondsFormat::Millis, true);
                    let calculated = calculation::calculate(conn, &asked, &as_of).await?;
                    checked.recommendation_id = Some(calculated.id);
                    summary.recalculated += 1;
                    (checked.outcome, checked.reason) = if calculated.requires_review {
                        ("review-required", "recommendation-needs-review")
                    } else {
                        ("recalculated", "publication-remains-disabled")
                    };
                }
            }
        }
        // Continue promptly after scheduled reads; unrelated sources do not block already fresh selected evidence.
        checked.waiting = checked.waiting
            || by_key
                .iter()
                .any(|s| s.state == "queued" || s.state == "running")
            || specs.iter().any(|(key, spec)| {
                self.usable(spec) && status(&by_key, key).is_none_or(|at| by_key[at].stale)
            });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::DateTime;
    use serde_json::{Value, json};

    use super::*;
    use crate::database::Database;

    /// `tests/fixtures/node/slab/cycle-seed.sql` with its recommendations calculated and one
    /// reviewed, then the cycles Node's ran at the same time (`scripts/parity/slab-cycle.ts`): the
    /// first, one with every listing due again, one with the evidence expired and one with no
    /// seller due, in one transaction rolled back. Each cycle's summary and everything saved
    /// (settings, checks, refreshes, recommendations) as Node's.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back"]
    async fn cycles_run_as_node_runs_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| {
            std::fs::read_to_string(format!("tests/fixtures/node/slab/{name}")).unwrap()
        };
        let node: Vec<Value> = serde_json::from_str(&read("cycle.node.json")).unwrap();
        let asked: Vec<Value> = serde_json::from_str(&read("cycle-recommendations.json")).unwrap();
        let capture = read("cycle-capture.sql");
        let at = "2026-10-31T18:00:00.000Z";
        let now: DateTime<Utc> = at.parse().unwrap();
        let mut conn = db.0.acquire().await.unwrap();
        // Its seed writes the evidence tables, so it waits for the evidence tests rather than
        // deadlocking with one that empties them.
        let mut tx = crate::features::slab_evidence::store::alone(&mut conn).await;
        sqlx::raw_sql(&read("cycle-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let policy = Policy::with_basis("item-plus-shipping");
        let seller: Seller = serde_json::from_value(json!({
            "currency": "USD", "currentAsk": 99, "shippingCharged": 4.99, "shippingCost": 4.25, "acquisitionCost": 60,
            "fees": { "rate": 0.1325, "fixed": 0.4, "basis": "item-plus-shipping" }, "minimumAsk": 50, "minimumProfit": 10
        }))
        .unwrap();
        for one in &asked {
            let ids: Vec<String> = serde_json::from_value(one["revisionIds"].clone()).unwrap();
            let asked = Asked {
                slab_id: one["slabId"].as_str().unwrap(),
                identity_revision: one["identityRevision"].as_i64().unwrap(),
                revision_ids: &ids,
                policy: &policy,
                seller: &seller,
                replacing: None,
            };
            calculation::calculate(&mut tx, &asked, at).await.unwrap();
        }
        sqlx::raw_sql(&read("cycle-after-calculations.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for theirs in node {
            let step = theirs["step"].as_str().unwrap();
            if let Some(before) = theirs["before"].as_str() {
                sqlx::raw_sql(before).execute(&mut *tx).await.unwrap();
            }
            let summary = run(&mut tx, now).await.unwrap();
            assert_eq!(json!(summary), theirs["summary"], "{step}");
            let saved: Value = sqlx::query_scalar(capture.as_str())
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(saved, theirs["saved"], "{step}");
        }
        tx.rollback().await.unwrap();
    }
}
