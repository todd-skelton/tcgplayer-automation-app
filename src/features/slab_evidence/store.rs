//! The evidence refresh queue and what it saved, ported from `evidenceRefreshStore.server.ts` and
//! the payload checks of `evidenceRefreshProvider.server.ts`.
//!
//! A request is kept under its key with one refresh at a time: requested again while it is queued
//! or running, or while what was fetched is fresh, it is not fetched again unless forced. A worker
//! claims the highest priority refresh under a 90-second lease, at most three attempts, and saves
//! what it fetched as a revision only while its lease holds.
//!
//! Supply (the asks on unsold listings) is saved with its listings as a scan: that is not ported
//! yet, and a supply refresh completed here is refused.
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection, PgExecutor};

use super::spec::{Refused, Spec};
use crate::features::inventory_economics::ledger::fingerprint::js_numbers;

/// A refusal the operator can act on, or the database failing.
#[derive(Debug)]
pub enum Error {
    Refused(Refused),
    Database(sqlx::Error),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Refused(why) => why.fmt(f),
            Error::Database(why) => why.fmt(f),
        }
    }
}

impl From<Refused> for Error {
    fn from(why: Refused) -> Self {
        Error::Refused(why)
    }
}

impl From<sqlx::Error> for Error {
    fn from(why: sqlx::Error) -> Self {
        Error::Database(why)
    }
}

fn refused<T>(message: &str) -> Result<T, Error> {
    Err(Error::Refused(Refused(message.to_owned())))
}

/// Where one request's refresh stands.
#[derive(Clone, Debug, PartialEq)]
pub struct Status {
    pub key: String,
    pub spec: Spec,
    /// `queued`, `running`, `idle`, `failed` or `cancelled`.
    pub state: String,
    pub run_id: String,
    pub latest_revision: Option<String>,
    pub fetched_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub error_code: Option<String>,
    pub attempts: i32,
    pub duration_ms: Option<i32>,
    /// Expired, never fetched, or failed.
    pub stale: bool,
}

#[derive(sqlx::FromRow)]
struct StatusRow {
    key: String,
    spec: String,
    state: String,
    run_id: String,
    latest_revision: Option<String>,
    fetched_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    error_code: Option<String>,
    attempts: i32,
    duration_ms: Option<i32>,
    stale: bool,
}

fn spec_of(text: &str) -> Result<Spec, Error> {
    serde_json::from_str(text).map_err(|e| Error::Database(sqlx::Error::Decode(Box::new(e))))
}

impl StatusRow {
    fn status(self) -> Result<Status, Error> {
        Ok(Status {
            spec: spec_of(&self.spec)?,
            key: self.key,
            state: self.state,
            run_id: self.run_id,
            latest_revision: self.latest_revision,
            fetched_at: self.fetched_at,
            expires_at: self.expires_at,
            error_code: self.error_code,
            attempts: self.attempts,
            duration_ms: self.duration_ms,
            stale: self.stale,
        })
    }
}

const STATUS: &str =
    "key,spec::text AS spec,state,run_id::text AS run_id,latest_revision::text AS latest_revision,
  fetched_at,expires_at,error_code,attempts,duration_ms,
  (expires_at IS NULL OR expires_at<=clock_timestamp() OR state='failed') AS stale";

/// A refresh a worker holds.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub key: String,
    pub spec: Spec,
    pub run_id: String,
    pub lease_id: String,
    pub attempts: i32,
}

/// `keysInput`: at most 200 keys, each a sha256, once each in the order given.
fn keys_input(keys: &[String]) -> Result<Vec<String>, Error> {
    let hex =
        |k: &String| k.len() == 64 && k.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if keys.len() > 200 || !keys.iter().all(hex) {
        return refused("Choose at most 200 evidence keys.");
    }
    let mut unique: Vec<String> = Vec::new();
    for key in keys {
        if !unique.contains(key) {
            unique.push(key.clone());
        }
    }
    Ok(unique)
}

fn uuid_shaped(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// `evidenceStatuses`: the refreshes of `keys` there are, in key order.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the screen asks the Node app, whose answer wakes its worker"
    )
)]
pub async fn statuses(db: impl PgExecutor<'_>, keys: &[String]) -> Result<Vec<Status>, Error> {
    let keys = keys_input(keys)?;
    let rows: Vec<StatusRow> = sqlx::query_as(&format!(
        "SELECT {STATUS} FROM slab_evidence_refreshes WHERE key=ANY($1::text[]) ORDER BY key"
    ))
    .bind(&keys)
    .fetch_all(db)
    .await?;
    rows.into_iter().map(StatusRow::status).collect()
}

/// `requestEvidence`: each request queued unless it is queued or running already, or (unless
/// `force`) what was fetched is still fresh or its retry is not due; a queued one is raised to
/// `priority`. Answers where each stands.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the screen asks the Node app, whose answer wakes its worker"
    )
)]
pub async fn request(
    conn: &mut PgConnection,
    specs: &[Spec],
    force: bool,
    priority: i32,
) -> Result<Vec<Status>, Error> {
    if specs.len() > 200 {
        return refused("Choose at most 200 evidence requests.");
    }
    if !(0..=300).contains(&priority) {
        return refused("Invalid refresh priority.");
    }
    let mut entries: Vec<(String, Spec)> = Vec::new();
    for spec in specs {
        let spec = spec.normalized()?;
        let key = spec.key()?;
        match entries.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = spec,
            None => entries.push((key, spec)),
        }
    }
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = entries
        .iter()
        .map(|(key, spec)| json!({ "key": key, "spec": spec }))
        .collect();
    sqlx::query(
        "INSERT INTO slab_evidence_refreshes (key,spec,run_id,state,priority)
         SELECT x.key,x.spec,gen_random_uuid(),'queued',$2 FROM jsonb_to_recordset($1::jsonb) AS x(key text,spec jsonb)
         ON CONFLICT (key) DO UPDATE SET state='queued',run_id=EXCLUDED.run_id,priority=EXCLUDED.priority,
           attempts=0,available_at=clock_timestamp(),lease_id=NULL,lease_until=NULL,error_code=NULL,updated_at=clock_timestamp()
         WHERE slab_evidence_refreshes.state NOT IN ('queued','running')
           AND ($3 OR (slab_evidence_refreshes.available_at<=clock_timestamp()
             AND (slab_evidence_refreshes.expires_at IS NULL OR slab_evidence_refreshes.expires_at<=clock_timestamp())))",
    )
    .bind(Value::Array(rows).to_string())
    .bind(priority)
    .bind(force)
    .execute(&mut *conn)
    .await?;
    let keys: Vec<String> = entries.into_iter().map(|(key, _)| key).collect();
    // A request that coalesces with one queued, or reads what is fresh, fetches nothing more.
    sqlx::query(
        "UPDATE slab_evidence_refreshes SET priority=$2 WHERE key=ANY($1::text[]) AND state='queued' AND priority<$2",
    )
    .bind(&keys)
    .bind(priority)
    .execute(&mut *conn)
    .await?;
    statuses(&mut *conn, &keys).await
}

/// `claimEvidenceJob`: the next refresh due, leased for 90 seconds; a final attempt whose lease
/// expired fails first rather than waiting forever.
pub async fn claim(conn: &mut PgConnection) -> Result<Option<Job>, Error> {
    sqlx::query(
        "UPDATE slab_evidence_refreshes SET state='failed',error_code='lease-expired',lease_id=NULL,lease_until=NULL,
           available_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
         WHERE state='running' AND lease_until<=clock_timestamp() AND attempts>=3",
    )
    .execute(&mut *conn)
    .await?;
    let row: Option<(String, String, String, String, i32)> = sqlx::query_as(
        "UPDATE slab_evidence_refreshes SET state='running',attempts=attempts+1,
           lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
         WHERE key=(SELECT key FROM slab_evidence_refreshes WHERE attempts<3 AND
           ((state='queued' AND available_at<=clock_timestamp()) OR (state='running' AND lease_until<=clock_timestamp()))
           ORDER BY priority DESC,available_at,key FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING key,spec::text,run_id::text,lease_id::text,attempts",
    )
    .fetch_optional(&mut *conn)
    .await?;
    row.map(|(key, spec, run_id, lease_id, attempts)| {
        Ok(Job {
            key,
            spec: spec_of(&spec)?,
            run_id,
            lease_id,
            attempts,
        })
    })
    .transpose()
}

/// `evidenceJobActive`: whether the worker still holds the refresh.
pub async fn active(db: impl PgExecutor<'_>, job: &Job) -> Result<bool, Error> {
    let held: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM slab_evidence_refreshes WHERE key=$1 AND run_id=$2::uuid AND lease_id=$3::uuid
           AND state='running' AND lease_until>clock_timestamp()",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .bind(&job.lease_id)
    .fetch_optional(db)
    .await?;
    Ok(held.is_some())
}

/// The codes a failure is saved under; any other is `unavailable`.
const ERROR_CODES: [&str; 8] = [
    "not-configured",
    "reconnect-required",
    "busy",
    "rate-limited",
    "unavailable",
    "invalid-response",
    "cancelled",
    "lease-expired",
];

/// `failEvidenceJob`: queued again after 30 seconds per attempt when `retry` and attempts remain,
/// otherwise failed (or cancelled) for ten minutes. Only while the worker holds it.
pub async fn fail(
    db: impl PgExecutor<'_>,
    job: &Job,
    code: &str,
    retry: bool,
) -> Result<(), Error> {
    let next = if retry && job.attempts < 3 {
        "queued"
    } else if code == "cancelled" {
        "cancelled"
    } else {
        "failed"
    };
    let code = if ERROR_CODES.contains(&code) {
        code
    } else {
        "unavailable"
    };
    let wait = if next == "queued" {
        30 * job.attempts
    } else {
        600
    };
    sqlx::query(
        "UPDATE slab_evidence_refreshes SET state=$4,error_code=$5,lease_id=NULL,lease_until=NULL,
           available_at=clock_timestamp()+$6*interval '1 second',updated_at=clock_timestamp()
         WHERE key=$1 AND run_id=$2::uuid AND lease_id=$3::uuid AND state='running' AND lease_until>clock_timestamp()",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .bind(&job.lease_id)
    .bind(next)
    .bind(code)
    .bind(wait)
    .execute(db)
    .await?;
    Ok(())
}

/// `cancelEvidenceRefresh`: a queued or running refresh of this run stopped. Answers the keys
/// cancelled: none when it was run again since or had finished.
pub async fn cancel(
    db: impl PgExecutor<'_>,
    key: &str,
    run_id: &str,
) -> Result<Vec<String>, Error> {
    keys_input(&[key.to_owned()])?;
    if !uuid_shaped(run_id) {
        return refused("Provide the current refresh run.");
    }
    Ok(sqlx::query_scalar(
        "UPDATE slab_evidence_refreshes SET state='cancelled',error_code='cancelled',lease_id=NULL,lease_until=NULL,
           available_at=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp()
         WHERE key=$1 AND run_id=$2::uuid AND state IN ('queued','running') RETURNING key",
    )
    .bind(key)
    .bind(run_id)
    .fetch_all(db)
    .await?)
}

/// What a fetch answered, compacted: its rows once each.
#[derive(Clone, Debug, PartialEq)]
pub struct Compact {
    pub payload: Value,
    pub bytes: usize,
    pub observations: usize,
}

fn rows_field(payload: &Value) -> Option<&'static str> {
    let data = &payload["data"];
    match payload["kind"].as_str() {
        Some("alt-sales") => Some("sales"),
        Some("ebay-sales") if data["status"] == "sold" => Some("sales"),
        Some("alt-supply" | "ebay-supply") => Some("listings"),
        _ => None,
    }
}

/// `compactEvidence`: copies of one event in one answer collapsed (conflicting copies refused),
/// within the observation and storage limits.
pub fn compact(payload: &Value) -> Result<Compact, Error> {
    let field = rows_field(payload);
    let rows: Vec<Value> = match field {
        Some(field) => payload["data"][field]
            .as_array()
            .cloned()
            .unwrap_or_default(),
        None if payload["kind"] == "alt-sale-detail" && is_truthy(&payload["data"]) => {
            vec![payload["data"].clone()]
        }
        None => Vec::new(),
    };
    if rows.len() > 2000 {
        return refused("Evidence response exceeds the observation limit.");
    }
    let mut order: Vec<String> = Vec::new();
    let mut unique: HashMap<String, Value> = HashMap::new();
    for row in rows {
        let present = |name: &str| row.as_object().and_then(|o| o.get(name)).cloned();
        let identity = json!([
            row["provider"],
            row["providerId"],
            present("kind").unwrap_or_else(|| Value::from("supply")),
            present("date").unwrap_or(Value::Null),
        ])
        .to_string();
        if let Some(previous) = unique.get(&identity) {
            if *previous != row {
                return refused("Evidence source returned conflicting copies of one event.");
            }
        } else {
            order.push(identity.clone());
        }
        unique.insert(identity, row);
    }
    let observations = unique.len();
    let mut payload = js_numbers(payload);
    if let Some(field) = field {
        payload["data"][field] =
            Value::Array(order.iter().map(|k| js_numbers(&unique[k])).collect());
    }
    let bytes = payload.to_string().len();
    if bytes > 1024 * 1024 {
        return refused("Normalized evidence exceeds the storage limit.");
    }
    Ok(Compact {
        payload,
        bytes,
        observations,
    })
}

fn is_truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
        && value.as_str() != Some("")
        && value.as_f64() != Some(0.0)
}

/// `validateEvidencePayload`: what was fetched is what was asked for.
pub fn validate(spec: &Spec, payload: &Value) -> Result<(), Error> {
    let invalid = || refused("Evidence does not match the requested identity, window or page.");
    if payload["kind"] != spec.kind() {
        return invalid();
    }
    let data = &payload["data"];
    let rows = |field: &str| data[field].as_array().cloned().unwrap_or_default();
    let window_is = |coverage: &Value, window: &super::spec::Window| {
        coverage["requestedWindow"]["from"] == window.from.as_str()
            && coverage["requestedWindow"]["to"] == window.to.as_str()
    };
    match spec {
        Spec::AltSales {
            asset_id,
            window,
            limit_per_grade,
        } => {
            if !window_is(&data["coverage"], window)
                || data["coverage"]["limitPerGrade"] != *limit_per_grade
                || rows("sales")
                    .iter()
                    .any(|r| r["provider"] != "alt" || r["assetId"] != asset_id.as_str())
            {
                return invalid();
            }
        }
        Spec::AltSupply { asset_id } => {
            if rows("listings")
                .iter()
                .any(|r| r["provider"] != "alt" || r["assetId"] != asset_id.as_str())
            {
                return invalid();
            }
        }
        Spec::AltSaleDetail { transaction_id } => {
            if is_truthy(data)
                && (data["provider"] != "alt" || data["providerId"] != transaction_id.as_str())
            {
                return invalid();
            }
        }
        Spec::EbaySales(page) | Spec::EbaySupply(page) => {
            if data["status"] == "active-fallback" {
                return refused(
                    "eBay fell back to active listings; prior sold evidence was retained.",
                );
            }
            let paged = &data["page"];
            if data["keywords"] != page.keywords.as_str()
                || !is_truthy(paged)
                || paged["offset"] != page.offset
                || paged["limit"] != page.limit
            {
                return invalid();
            }
            if matches!(spec, Spec::EbaySales(_))
                && (!window_is(&data["coverage"], &page.window)
                    || rows("sales")
                        .iter()
                        .any(|r| r["provider"] != "ebayResearch"))
            {
                return invalid();
            }
        }
    }
    Ok(())
}

/// `completeEvidenceJob`: what the worker fetched saved as the refresh's revision, fresh for its
/// kind's time, only while the worker still holds it. Answers whether it was saved.
pub async fn complete(
    conn: &mut PgConnection,
    job: &Job,
    payload: &Value,
    duration_ms: f64,
) -> Result<bool, Error> {
    if payload["kind"] != job.spec.kind() || job.spec.key()? != job.key {
        return refused("Evidence does not match its refresh request.");
    }
    let compact = compact(payload)?;
    validate(&job.spec, &compact.payload)?;
    if matches!(job.spec, Spec::AltSupply { .. } | Spec::EbaySupply(_)) {
        return refused("Supply scans are saved by the Node app until they are ported.");
    }
    let mut tx = conn.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await?;
    let held: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM slab_evidence_refreshes WHERE key=$1 AND run_id=$2::uuid AND lease_id=$3::uuid
           AND state='running' AND lease_until>clock_timestamp() FOR UPDATE",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .bind(&job.lease_id)
    .fetch_optional(&mut *tx)
    .await?;
    if held.is_none() {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO slab_evidence_revisions(id,key,payload,fetched_at,byte_count,observation_count,supply_scan_id)
         VALUES ($1::uuid,$2,$3::jsonb,clock_timestamp(),$4,$5,NULL)",
    )
    .bind(&job.run_id)
    .bind(&job.key)
    .bind(compact.payload.to_string())
    .bind(compact.bytes as i32)
    .bind(compact.observations as i32)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE slab_evidence_refreshes SET state='idle',latest_revision=$2::uuid,fetched_at=clock_timestamp(),
           expires_at=clock_timestamp()+$4*interval '1 second',available_at=clock_timestamp(),error_code=NULL,
           duration_ms=$3,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE key=$1",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .bind(duration_ms.round().clamp(0.0, 120_000.0) as i32)
    .bind(job.spec.ttl_seconds())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// What a clean removed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cleaned {
    pub history_removed: u64,
    pub keys_removed: usize,
}

/// `cleanEvidenceCache`: old supply scans and unused listing versions, revisions over 30 days
/// old that nothing keeps, and requests untouched for 90 days with nothing retained.
pub async fn clean(conn: &mut PgConnection) -> Result<Cleaned, Error> {
    let mut tx = conn.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await?;
    // `cleanSupplyObservations`
    sqlx::query(
        "DELETE FROM slab_supply_scans WHERE id IN (SELECT s.id FROM slab_supply_scans s
           WHERE captured_at<clock_timestamp()-interval '180 days'
             AND NOT EXISTS(SELECT 1 FROM slab_evidence_revisions r WHERE r.supply_scan_id=s.id)
           ORDER BY captured_at LIMIT 200 FOR UPDATE SKIP LOCKED)",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM slab_supply_versions WHERE hash IN (SELECT v.hash FROM slab_supply_versions v
           WHERE NOT EXISTS(SELECT 1 FROM slab_supply_observations o WHERE o.version_hash=v.hash)
           ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)",
    )
    .execute(&mut *tx)
    .await?;
    // The latest and retained revisions outlive the 30 days of history.
    let removed = sqlx::query(
        "DELETE FROM slab_evidence_revisions WHERE id IN (
           SELECT r.id FROM slab_evidence_revisions r WHERE NOT retained AND created_at<clock_timestamp()-interval '30 days'
             AND NOT EXISTS (SELECT 1 FROM slab_evidence_refreshes j WHERE j.latest_revision=r.id)
           ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED)",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let old: Vec<String> = sqlx::query_scalar(
        "SELECT j.key FROM slab_evidence_refreshes j WHERE state NOT IN ('queued','running')
           AND updated_at<clock_timestamp()-interval '90 days'
           AND NOT EXISTS (SELECT 1 FROM slab_evidence_revisions r WHERE r.key=j.key AND r.retained)
         ORDER BY updated_at LIMIT 100 FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await?;
    // Revisions locked, then retention checked again: a recommendation may have kept one since.
    sqlx::query("SELECT id FROM slab_evidence_revisions WHERE key=ANY($1::text[]) FOR UPDATE")
        .bind(&old)
        .execute(&mut *tx)
        .await?;
    let keys: Vec<String> = sqlx::query_scalar(
        "SELECT key FROM slab_evidence_refreshes j WHERE key=ANY($1::text[])
           AND NOT EXISTS (SELECT 1 FROM slab_evidence_revisions r WHERE r.key=j.key AND r.retained)",
    )
    .bind(&old)
    .fetch_all(&mut *tx)
    .await?;
    if !keys.is_empty() {
        for sql in [
            "UPDATE slab_evidence_refreshes SET latest_revision=NULL WHERE key=ANY($1::text[])",
            "DELETE FROM slab_evidence_revisions WHERE key=ANY($1::text[])",
            "DELETE FROM slab_evidence_refreshes WHERE key=ANY($1::text[])",
        ] {
            sqlx::query(sql).bind(&keys).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(Cleaned {
        history_removed: removed,
        keys_removed: keys.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        database::Database,
        features::slab_evidence::spec::{EbayPage, Window},
    };

    fn brief(statuses: &[Status]) -> Value {
        Value::Array(
            statuses
                .iter()
                .map(|s| json!({ "key": s.key, "state": s.state, "stale": s.stale, "attempts": s.attempts, "error": s.error_code }))
                .collect(),
        )
    }

    #[test]
    fn copies_of_one_event_collapse_and_conflicting_ones_are_refused() {
        let row = json!({ "provider": "alt", "providerId": "s-1", "kind": "sale", "date": "2026-09-01", "price": { "amount": 100.0 } });
        let payload = json!({ "kind": "alt-sales", "data": { "sales": [row, row] } });
        let compact = compact(&payload).unwrap();
        assert_eq!(compact.observations, 1);
        assert_eq!(
            compact.payload["data"]["sales"][0]["price"]["amount"].to_string(),
            "100"
        );
        let mut other = row.clone();
        other["price"]["amount"] = json!(101);
        let conflicting = json!({ "kind": "alt-sales", "data": { "sales": [row, other] } });
        assert!(
            matches!(compact_err(&conflicting), Some(m) if m == "Evidence source returned conflicting copies of one event.")
        );
    }

    fn compact_err(payload: &Value) -> Option<String> {
        match compact(payload) {
            Err(Error::Refused(why)) => Some(why.0),
            _ => None,
        }
    }

    /// The scenario of `.port-logs/slab-evidence-node.ts` (requests, claims, two saved, a retry, a
    /// failure, a cancel, a forced request) on the dev database in a transaction rolled back,
    /// compared with what Node answered and wrote (`.port-logs/slab-evidence-capture.sql`).
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn the_queue_runs_as_node_runs_it() {
        crate::config::load_env();
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/slab-evidence.node.json").unwrap(),
        )
        .unwrap();
        let scenario: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/slab-evidence-scenario.json").unwrap(),
        )
        .unwrap();
        let capture = std::fs::read_to_string(".port-logs/slab-evidence-capture.sql").unwrap();
        let window = Window {
            from: "2025-10-30".into(),
            to: "2026-10-30".into(),
        };
        let ebay = |offset| EbayPage {
            group_key: "ab".repeat(32),
            keywords: "PSA 10 Charizard Base Set".into(),
            window: window.clone(),
            offset,
            limit: 50,
            timezone: "America/Chicago".into(),
        };
        let specs = vec![
            Spec::AltSales {
                asset_id: "asset-1".into(),
                window: window.clone(),
                limit_per_grade: 16,
            },
            Spec::AltSupply {
                asset_id: "asset-1".into(),
            },
            Spec::AltSaleDetail {
                transaction_id: "tx-9".into(),
            },
            Spec::EbaySales(ebay(0)),
            Spec::EbaySupply(ebay(50)),
        ];
        let keys: Vec<String> = specs.iter().map(|s| s.key().unwrap()).collect();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        // The queue's tests write the same keys: one at a time, or their transactions deadlock.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('slab_evidence_refreshes tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut steps = Vec::new();
        steps.push(brief(&request(&mut tx, &specs, false, 200).await.unwrap()));
        steps.push(brief(
            &request(&mut tx, &[specs[2].clone(), specs[3].clone()], false, 250)
                .await
                .unwrap(),
        ));
        let first = claim(&mut tx).await.unwrap().unwrap();
        let saved = complete(&mut tx, &first, &scenario["detail"], 1234.4)
            .await
            .unwrap();
        steps.push(json!({ "claimed": first.key, "attempts": first.attempts, "saved": saved }));
        let second = claim(&mut tx).await.unwrap().unwrap();
        fail(&mut *tx, &second, "busy", true).await.unwrap();
        steps.push(json!({ "claimed": second.key, "attempts": second.attempts }));
        let third = claim(&mut tx).await.unwrap().unwrap();
        let saved = complete(&mut tx, &third, &scenario["sales"], 87.6)
            .await
            .unwrap();
        steps.push(json!({ "claimed": third.key, "saved": saved }));
        let fourth = claim(&mut tx).await.unwrap().unwrap();
        fail(&mut *tx, &fourth, "weird-code", false).await.unwrap();
        steps.push(json!({ "claimed": fourth.key }));
        let supply = statuses(&mut *tx, &keys[4..]).await.unwrap().remove(0);
        steps.push(
            json!({ "cancelled": cancel(&mut *tx, &keys[4], &supply.run_id).await.unwrap() }),
        );
        steps.push(brief(
            &request(&mut tx, &specs[..1], false, 100).await.unwrap(),
        ));
        steps.push(brief(
            &request(&mut tx, &specs[1..2], true, 100).await.unwrap(),
        ));
        steps.push(json!({ "next": claim(&mut tx).await.unwrap().map(|j| j.key) }));
        steps.push(brief(&statuses(&mut *tx, &keys).await.unwrap()));
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let captured: Value = serde_json::from_str(&captured).unwrap();
        for (index, (ours, theirs)) in steps
            .iter()
            .zip(node["steps"].as_array().unwrap())
            .enumerate()
        {
            assert_eq!(ours, theirs, "step {index}");
        }
        assert_eq!(captured["refreshes"], node["captured"]["refreshes"]);
        assert_eq!(captured["revisions"], node["captured"]["revisions"]);
    }
}
