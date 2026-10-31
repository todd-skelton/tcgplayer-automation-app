//! Supply scans: the asks on unsold listings a supply refresh read, kept as a scan of listing
//! versions so an unchanged listing is stored once across scans. Ported from
//! `supply/supplyObservations.server.ts`.
//!
//! A scan is recorded inside the transaction that saves its refresh's revision, so a refresh whose
//! lease was lost or cancelled adds no history. Each source keeps its 200 latest scans.
use std::collections::HashMap;

use chrono::DateTime;
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::store::{Error, Job, refused};
use crate::features::{
    inventory_economics::ledger::fingerprint::{locale_json, sha256_hex},
    inventory_strategy::collate,
};

/// One listing as a scan stores it: its version's hash, the listing it is a version of, and
/// what was read.
#[derive(Clone, Debug, PartialEq)]
pub struct Version {
    pub hash: String,
    pub listing_key: String,
    pub payload: Value,
}

/// A value as JavaScript writes it into a template string.
fn template_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => locale_json(other),
    }
}

/// `supplyListingKey`: the provider and its id for the listing.
pub fn listing_key(listing: &Value) -> String {
    format!(
        "{}:{}",
        template_text(&listing["provider"]),
        template_text(&listing["providerId"])
    )
}

/// `supplyVersion`: the listing with a title and extended title (null when absent) and its
/// items in order, hashed as its keys sorted.
pub fn version(listing: &Value) -> Result<Version, Error> {
    let Some(fields) = listing.as_object() else {
        return refused("A supply listing is not an object.");
    };
    let Some(items) = fields.get("items").and_then(Value::as_array) else {
        return refused("A supply listing has no items.");
    };
    let mut items: Vec<(String, Value)> = items
        .iter()
        .map(|item| (locale_json(item), item.clone()))
        .collect();
    items.sort_by(|(a, _), (b, _)| collate::compare(a, b));
    let mut payload = fields.clone();
    for name in ["title", "extendedTitle"] {
        let entry = payload.entry(name).or_insert(Value::Null);
        if entry.is_null() {
            *entry = Value::Null;
        }
    }
    payload.insert(
        "items".into(),
        Value::Array(items.into_iter().map(|(_, item)| item).collect()),
    );
    let payload = Value::Object(payload);
    Ok(Version {
        hash: sha256_hex(&locale_json(&payload)),
        listing_key: listing_key(listing),
        payload,
    })
}

fn is_supply(kind: &Value) -> bool {
    kind == "alt-supply" || kind == "ebay-supply"
}

/// `recordSupplyScan`: the listings of a supply refresh's `payload` saved as the scan of
/// `job`'s run, on `conn` inside the transaction saving its revision. Recording the same scan
/// again changes nothing; recording different content under its run is refused.
pub async fn record(conn: &mut PgConnection, job: &Job, payload: &Value) -> Result<(), Error> {
    if !is_supply(&payload["kind"]) {
        return Ok(());
    }
    if payload["kind"] != job.spec.kind() {
        return refused("Supply does not match its source request.");
    }
    let data = &payload["data"];
    let listings = data["listings"].as_array().cloned().unwrap_or_default();
    if listings.len() > 2000 {
        return refused("Supply exceeds the observation limit.");
    }
    // Each listing once, where it first appeared, unless its copies disagree.
    let mut rows: Vec<Version> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for listing in &listings {
        let version = version(listing)?;
        match seen.get(&version.listing_key) {
            Some(&at) if rows[at].hash != version.hash => {
                return refused("A supply scan contains contradictory copies of a listing.");
            }
            Some(&at) => rows[at] = version,
            None => {
                seen.insert(version.listing_key.clone(), rows.len());
                rows.push(version);
            }
        }
    }
    let references: Vec<[&str; 2]> = rows
        .iter()
        .map(|row| [row.listing_key.as_str(), row.hash.as_str()])
        .collect();
    let content_hash = sha256_hex(&serde_json::to_string(&references).unwrap_or_default());
    let as_of = data["asOf"].as_str();
    let (group, asset) = match &job.spec {
        super::spec::Spec::EbaySupply(page) => (Some(page.group_key.as_str()), None),
        super::spec::Spec::AltSupply { asset_id } => (None, Some(asset_id.as_str())),
        _ => (None, None),
    };
    let provider = if payload["kind"] == "alt-supply" {
        "alt"
    } else {
        "ebayResearch"
    };
    let inserted: Option<String> = sqlx::query_scalar(
        "INSERT INTO slab_supply_scans(id,source_key,provider,valuation_group_key,asset_id,captured_at,complete,reported_count,stored_count,content_hash)
         VALUES($1::uuid,$2,$3,$4,$5,$6::timestamptz,false,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id::text",
    )
    .bind(&job.run_id)
    .bind(&job.key)
    .bind(provider)
    .bind(group)
    .bind(asset)
    .bind(as_of)
    .bind(listings.len() as i32)
    .bind(rows.len() as i32)
    .bind(&content_hash)
    .fetch_optional(&mut *conn)
    .await?;
    if inserted.is_none() {
        let existing: Option<(String, DateTime<chrono::Utc>, String, i32)> = sqlx::query_as(
            "SELECT content_hash,captured_at,source_key,reported_count FROM slab_supply_scans WHERE id=$1::uuid",
        )
        .bind(&job.run_id)
        .fetch_optional(&mut *conn)
        .await?;
        let as_of_ms = as_of
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .map(|at| at.timestamp_millis());
        let same = existing.is_some_and(|(hash, captured, source, reported)| {
            hash == content_hash
                && source == job.key
                && Some(captured.timestamp_millis()) == as_of_ms
                && reported as usize == listings.len()
        });
        if !same {
            return refused("Supply revision content changed.");
        }
        return Ok(());
    }
    let previous: Option<(String, String)> = sqlx::query_as(
        "SELECT id::text,content_hash FROM slab_supply_scans WHERE source_key=$1 AND id<>$2::uuid
         ORDER BY captured_at DESC,id DESC LIMIT 1 FOR SHARE",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .fetch_optional(&mut *conn)
    .await?;
    match previous {
        Some((id, hash)) if hash == content_hash => {
            let copied = sqlx::query(
                "INSERT INTO slab_supply_observations(scan_id,listing_key,version_hash,position)
                 SELECT $1::uuid,listing_key,version_hash,position FROM slab_supply_observations WHERE scan_id=$2::uuid",
            )
            .bind(&job.run_id)
            .bind(&id)
            .execute(&mut *conn)
            .await?
            .rows_affected();
            if copied as usize != rows.len() {
                return refused("Supply references changed during capture.");
            }
        }
        _ => {
            let records = Value::Array(
                rows.iter()
                    .enumerate()
                    .map(|(position, row)| {
                        json!({ "hash": row.hash, "listing_key": row.listing_key, "payload": row.payload, "position": position })
                    })
                    .collect(),
            )
            .to_string();
            // The no-op update holds each version's row lock through the observations' insert,
            // so retention cannot remove a version in between.
            sqlx::query(
                "INSERT INTO slab_supply_versions(hash,listing_key,payload) SELECT x.hash,x.listing_key,x.payload
                 FROM jsonb_to_recordset($1::jsonb) AS x(hash text,listing_key text,payload jsonb) ORDER BY x.listing_key,x.hash
                 ON CONFLICT(hash) DO UPDATE SET hash=EXCLUDED.hash",
            )
            .bind(&records)
            .execute(&mut *conn)
            .await?;
            sqlx::query(
                "INSERT INTO slab_supply_observations(scan_id,listing_key,version_hash,position)
                 SELECT $1::uuid,x.listing_key,x.hash,x.position FROM jsonb_to_recordset($2::jsonb) AS x(hash text,listing_key text,position smallint)",
            )
            .bind(&job.run_id)
            .bind(&records)
            .execute(&mut *conn)
            .await?;
        }
    }
    let old: Vec<String> = sqlx::query_scalar(
        "SELECT id::text FROM slab_supply_scans WHERE id IN (SELECT id FROM slab_supply_scans WHERE source_key=$1
           ORDER BY captured_at DESC,id DESC OFFSET 200 LIMIT 20) AND id<>$2::uuid FOR UPDATE SKIP LOCKED",
    )
    .bind(&job.key)
    .bind(&job.run_id)
    .fetch_all(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM slab_evidence_revisions r WHERE r.supply_scan_id=ANY($1::uuid[]) AND NOT r.retained
           AND NOT EXISTS(SELECT 1 FROM slab_evidence_refreshes j WHERE j.latest_revision=r.id)",
    )
    .bind(&old)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM slab_supply_scans s WHERE id=ANY($1::uuid[])
           AND NOT EXISTS(SELECT 1 FROM slab_evidence_revisions r WHERE r.supply_scan_id=s.id)",
    )
    .bind(&old)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The revision a supply refresh saves: what was read without its listings, which its scan
/// keeps.
pub fn without_listings(payload: &Value) -> Value {
    let mut stored = payload.clone();
    if is_supply(&payload["kind"])
        && let Some(data) = stored["data"].as_object_mut()
    {
        data.remove("listings");
    }
    stored
}

#[cfg(test)]
mod tests {
    use sqlx::Connection;

    use super::*;
    use crate::{
        database::Database,
        features::slab_evidence::{spec::Spec, store},
    };

    #[test]
    fn a_listing_is_hashed_with_its_items_in_order() {
        let listing = json!({
            "provider": "alt", "providerId": 7, "items": [{ "assetId": "b" }, { "assetId": "a" }]
        });
        let version = version(&listing).unwrap();
        assert_eq!(version.listing_key, "alt:7");
        assert_eq!(
            locale_json(&version.payload),
            r#"{"extendedTitle":null,"items":[{"assetId":"a"},{"assetId":"b"}],"provider":"alt","providerId":7,"title":null}"#
        );
    }

    /// The scans of `.port-logs/supply-scan-scenario.json` (a copy collapsed, the same scan again,
    /// changed content under one run, reordered and changed listings, contradictory copies, the
    /// wrong source, an eBay scan, an unchanged scan copied) and a supply refresh completed, on the
    /// dev database in a transaction rolled back, compared with what Node's
    /// `.port-logs/supply-scan-node.ts` answered and wrote.
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn scans_are_recorded_as_node_records_them() {
        crate::config::load_env();
        let read = |path: &str| std::fs::read_to_string(path).unwrap();
        let node: Value = serde_json::from_str(&read(".port-logs/supply-scan.node.json")).unwrap();
        let scenario: Value =
            serde_json::from_str(&read(".port-logs/supply-scan-scenario.json")).unwrap();
        let capture = read(".port-logs/supply-scan-capture.sql");
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('slab_evidence_refreshes tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut steps = Vec::new();
        for scan in scenario["scans"].as_array().unwrap() {
            let spec: Spec = serde_json::from_value(scan["spec"].clone()).unwrap();
            let run = scan["run"].as_str().unwrap().to_owned();
            let job = store::Job {
                key: spec.key().unwrap(),
                spec,
                run_id: run.clone(),
                lease_id: run.clone(),
                attempts: 1,
            };
            let mut savepoint = tx.begin().await.unwrap();
            match record(&mut savepoint, &job, &scan["payload"]).await {
                Ok(()) => {
                    savepoint.commit().await.unwrap();
                    steps.push(json!({ "run": run, "ok": true }));
                }
                Err(Error::Refused(why)) => {
                    savepoint.rollback().await.unwrap();
                    steps.push(json!({ "run": run, "error": why.0 }));
                }
                Err(why) => panic!("{why}"),
            }
        }
        let completed = &scenario["completed"];
        let spec: Spec = serde_json::from_value(completed["spec"].clone()).unwrap();
        store::request(&mut tx, &[spec], false, 200).await.unwrap();
        let job = store::claim(&mut tx).await.unwrap().unwrap();
        let saved = store::complete(&mut tx, &job, &completed["payload"], 10.0)
            .await
            .unwrap();
        steps.push(json!({ "completed": job.key, "saved": saved }));
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let captured: Value =
            serde_json::from_str(&captured.replace(&job.run_id, "completed-run")).unwrap();
        assert_eq!(Value::Array(steps), node["steps"]);
        for part in ["scans", "versions", "observations", "revisions"] {
            assert_eq!(captured[part], node["captured"][part], "{part}");
        }
    }
}
