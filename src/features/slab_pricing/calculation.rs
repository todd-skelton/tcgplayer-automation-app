//! Calculating the owned slab's recommendation (`calculateSlabRecommendation`) from the evidence
//! saved for it, never a provider: its confirmed identity held while the evidence is checked
//! to be its own and not newer than the calculation, its sales made events and comps, the market
//! and ask worked out, and the calculation saved once by the hash of its JSON, written as Node
//! writes it, with the evidence it used kept.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Connection, PgConnection};

use super::{
    comp_events::{self, Saved},
    publication::{is_id, iso, millis},
    research::Identity,
    screening::{Decision, Sale, SaleWindow, Target},
    valuation::{self, Policy, Quality, Seller},
};
use crate::features::inventory_economics::ledger::fingerprint::{js_json, jsonb_json, sha256_hex};

/// What to calculate: the slab at the identity revision shown, the evidence revisions chosen, the
/// policy and the seller's costs.
pub struct Asked<'a> {
    pub slab_id: &'a str,
    pub identity_revision: i64,
    pub revision_ids: &'a [String],
    pub policy: &'a Policy,
    pub seller: &'a Seller,
    /// For a recalculation in the background: the recommendation it replaces, which must still
    /// be the slab's latest and not reviewed. The identity is then held for update, so a review
    /// saved meanwhile waits for it.
    pub replacing: Option<&'a str>,
}

/// A recommendation saved: its id, whether its ask needs the operator's review, and the
/// calculation as Node wrote it (the JSON its input key hashes).
#[derive(Debug)]
pub struct Calculated {
    pub id: String,
    pub requires_review: bool,
    pub calculation: String,
}

/// Node's answer to anything but a refusal it words.
const UNABLE: &str = "Unable to calculate a slab recommendation.";
const LIMIT: &str = "Evidence expired or the selection exceeds the calculation limit.";
const FIVE_MIB: i64 = 5 * 1024 * 1024;
const DAY_MS: f64 = 86_400_000.0;

fn unable(error: impl std::fmt::Display) -> String {
    eprintln!("slab recommendation: {error}");
    UNABLE.to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Pinned<'a> {
    slab_id: &'a str,
    revision: i64,
    valuation_group_key: &'a str,
}

/// An evidence revision chosen, with its source's refresh.
struct Row {
    id: String,
    payload: Value,
    spec: Value,
    fetched_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
    latest_revision: Option<String>,
    state: String,
    bytes: i32,
}

fn instant(at: &DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// Whether a spec's `field` is the string `expected`, `undefined` matching only none.
fn names(spec: &Value, field: &str, expected: Option<&str>) -> bool {
    match (spec.get(field), expected) {
        (None, None) => true,
        (Some(Value::String(given)), Some(expected)) => given == expected,
        _ => false,
    }
}

/// What JavaScript reads as true.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn saved(row: &Row, window: SaleWindow, raw: &Value) -> Result<Saved, String> {
    let sale: Sale = serde_json::from_value(raw.clone()).map_err(unable)?;
    Ok(Saved {
        revision_id: row.id.clone(),
        fetched_at: instant(&row.fetched_at),
        window,
        sale,
        raw: raw.clone(),
    })
}

/// `calculateSlabRecommendation` at `as_of` (an ISO time) on `conn`, in a transaction of its
/// own: the recommendation saved, or the one saved before from the same calculation.
pub async fn calculate(
    conn: &mut PgConnection,
    asked: &Asked<'_>,
    as_of: &str,
) -> Result<Calculated, String> {
    let now = millis(as_of);
    if !is_id(asked.slab_id)
        || asked.identity_revision < 1
        || asked.revision_ids.len() > 20
        || asked.revision_ids.iter().any(|id| !is_id(id))
        || now.is_none()
        || asked.replacing.is_some_and(|id| !is_id(id))
    {
        return Err(
            "Choose a current slab identity and at most twenty evidence revisions.".to_owned(),
        );
    }
    let now = now.unwrap_or_default();
    let policy = valuation::validate_policy(asked.policy)?;
    let seller = valuation::validate_seller(asked.seller, &asked.policy.currency)?;
    let mut ids = asked.revision_ids.to_vec();
    ids.sort();
    ids.dedup();
    let mut tx = conn.begin().await.map_err(unable)?;
    sqlx::query("SET LOCAL statement_timeout = '15s'")
        .execute(&mut *tx)
        .await
        .map_err(unable)?;
    type Target_ = (String, Option<Value>, i32, Option<String>);
    let lock = if asked.replacing.is_some() {
        "UPDATE"
    } else {
        "SHARE"
    };
    let target: Option<Target_> = sqlx::query_as(&format!(
        "SELECT id::text, identity, revision, valuation_group_key FROM slab_identities
         WHERE id = $1::uuid AND revision = $2 AND status = 'confirmed' FOR {lock}"
    ))
    .bind(asked.slab_id)
    .bind(asked.identity_revision)
    .fetch_optional(&mut *tx)
    .await
    .map_err(unable)?;
    let changed =
        || "The slab identity changed or is unconfirmed. Reload before calculating.".to_owned();
    let (slab_id, identity, revision, group) = target.ok_or_else(changed)?;
    let identity = identity.filter(truthy).ok_or_else(changed)?;
    let group = group.filter(|g| !g.is_empty()).ok_or_else(changed)?;
    let identity: Identity = serde_json::from_value(identity).map_err(unable)?;
    // Background recalculation waits on, and gives way to, the operator's review.
    if let Some(replacing) = asked.replacing {
        let latest: Option<(String, bool)> = sqlx::query_as(
            "SELECT r.id::text, EXISTS(SELECT 1 FROM slab_price_overrides o WHERE o.recommendation_id=r.id)
             FROM slab_recommendations r WHERE r.slab_id=$1::uuid ORDER BY r.created_at DESC,r.id DESC LIMIT 1",
        )
        .bind(asked.slab_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unable)?;
        if latest.is_none_or(|(id, reviewed)| id != replacing || reviewed) {
            return Err(
                "The recommendation changed or has a reviewed price. Reload before recalculating."
                    .to_owned(),
            );
        }
    }
    let (count, bytes): (i32, i32) = sqlx::query_as(
        "SELECT count(*)::int, COALESCE(sum(byte_count),0)::int FROM slab_evidence_revisions WHERE id=ANY($1::uuid[])",
    )
    .bind(&ids)
    .fetch_one(&mut *tx)
    .await
    .map_err(unable)?;
    if count as usize != ids.len() || i64::from(bytes) > FIVE_MIB {
        return Err(LIMIT.to_owned());
    }
    type Record = (
        String,
        Value,
        DateTime<Utc>,
        i32,
        Value,
        Option<DateTime<Utc>>,
        Option<String>,
        String,
    );
    let rows: Vec<Record> = sqlx::query_as(
        "SELECT r.id::text, r.payload, r.fetched_at, r.byte_count, j.spec, j.expires_at, j.latest_revision::text, j.state
         FROM slab_evidence_revisions r JOIN slab_evidence_refreshes j ON j.key = r.key WHERE r.id = ANY($1::uuid[]) ORDER BY r.id FOR SHARE OF r",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(unable)?;
    let evidence: Vec<Row> = rows
        .into_iter()
        .map(
            |(id, payload, fetched_at, bytes, spec, expires_at, latest_revision, state)| Row {
                id,
                payload,
                spec,
                fetched_at,
                expires_at,
                latest_revision,
                state,
                bytes,
            },
        )
        .collect();
    let total: i64 = evidence.iter().map(|row| i64::from(row.bytes)).sum();
    if evidence.len() != ids.len() || total > FIVE_MIB {
        return Err(LIMIT.to_owned());
    }
    let asset = identity.provider_asset_id();
    let mut references = Vec::new();
    let (mut capped, mut partial, mut stale) = (false, false, false);
    for row in &evidence {
        if row.fetched_at.timestamp_millis() > now {
            return Err("Evidence was captured after this calculation time.".to_owned());
        }
        let kind = row.spec["kind"].as_str();
        if matches!(kind, Some("ebay-sales" | "ebay-supply"))
            && !names(&row.spec, "groupKey", Some(&group))
        {
            return Err("The eBay evidence belongs to another valuation identity.".to_owned());
        }
        if matches!(kind, Some("alt-sales" | "alt-supply")) && !names(&row.spec, "assetId", asset) {
            return Err("The Alt evidence belongs to another card asset.".to_owned());
        }
        stale = stale
            || row.expires_at.is_none_or(|at| at.timestamp_millis() <= now)
            || row.latest_revision.as_deref() != Some(row.id.as_str())
            || row.state == "failed";
        let data = &row.payload["data"];
        match row.payload["kind"].as_str() {
            Some("alt-supply" | "ebay-supply") => {
                return Err("Supply observations cannot be used as sold comps.".to_owned());
            }
            Some("alt-sale-detail") => {
                if !truthy(data) {
                    continue;
                }
                let other = data["assetId"].as_str().filter(|a| !a.is_empty());
                if let (Some(other), Some(asset)) = (other, asset.filter(|a| !a.is_empty()))
                    && other != asset
                {
                    return Err("The sale detail belongs to another card asset.".to_owned());
                }
                let from = iso(now - (policy.maximum_age_days * DAY_MS) as i64);
                let window = SaleWindow {
                    from: from.chars().take(10).collect(),
                    to: as_of.chars().take(10).collect(),
                };
                references.push(saved(row, window, data)?);
            }
            Some(kind) if kind == "alt-sales" || data["status"] == "sold" => {
                let coverage = &data["coverage"];
                if coverage.is_null() || !data["sales"].is_array() {
                    return Err(unable("sold evidence without coverage or sales"));
                }
                let window: SaleWindow =
                    serde_json::from_value(coverage["requestedWindow"].clone()).map_err(unable)?;
                capped = capped || coverage["reason"] == "capped-per-grade";
                partial = partial || !truthy(&coverage["complete"]);
                for sale in data["sales"].as_array().into_iter().flatten() {
                    references.push(saved(row, window.clone(), sale)?);
                }
            }
            _ => {}
        }
    }
    if references.len() > 2000 {
        return Err("Narrow the evidence selection to at most 2,000 observations.".to_owned());
    }
    let decided: Vec<Value> = sqlx::query_scalar(
        "SELECT decision FROM slab_comp_decisions WHERE valuation_group_key = $1 AND revision_id = ANY($2::uuid[]) ORDER BY revision_id,event_key",
    )
    .bind(&group)
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(unable)?;
    let decisions: Vec<Decision> = decided
        .iter()
        .map(|d| serde_json::from_value(d.clone()))
        .collect::<Result<_, _>>()
        .map_err(unable)?;
    let target = Target {
        confirmed: true,
        identity: Some(&identity),
        valuation_group_key: Some(&group),
    };
    let direct = comp_events::collect(&references, &target, &decisions, &policy);
    let quality = Quality {
        uncertain: direct.uncertain,
        rejected: direct.rejected,
        event_warnings: direct.event_warnings,
        stale,
        capped,
        partial,
    };
    let market = valuation::estimate(&direct.comps, quality, as_of, &policy)?;
    let ask = valuation::propose(&market, &seller, &policy)?;
    // Values read from JSONB are written in JSONB's key order, as Node writes what it read.
    let decisions = decided.iter().map(jsonb_json).collect::<Vec<_>>().join(",");
    let used = evidence
        .iter()
        .map(|row| {
            format!(
                r#"{{"revisionId":{},"fetchedAt":{},"expiresAt":{},"spec":{}}}"#,
                js_json(&row.id),
                js_json(&instant(&row.fetched_at)),
                js_json(&row.expires_at.as_ref().map(instant)),
                jsonb_json(&row.spec),
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let pinned = Pinned {
        slab_id: &slab_id,
        revision: i64::from(revision),
        valuation_group_key: &group,
    };
    let calculation = format!(
        r#"{{"identity":{},"policyVersion":"slab-policy-v1","policy":{},"seller":{},"market":{},"ask":{},"dispositions":{},"decisions":[{decisions}],"evidence":[{used}]}}"#,
        js_json(&pinned),
        js_json(&policy),
        js_json(&seller),
        js_json(&market),
        js_json(&ask),
        js_json(&direct.dispositions),
    );
    if calculation.len() > 512 * 1024 {
        return Err(
            "The calculation exceeds its storage limit. Narrow the evidence selection.".to_owned(),
        );
    }
    let input_key = sha256_hex(&calculation);
    let id: String = sqlx::query_scalar(
        "INSERT INTO slab_recommendations(id,input_key,slab_id,identity_revision,valuation_group_key,calculation)
         VALUES(gen_random_uuid(),$1,$2::uuid,$3,$4,$5::jsonb)
         ON CONFLICT(input_key) DO UPDATE SET input_key = EXCLUDED.input_key RETURNING id::text",
    )
    .bind(&input_key)
    .bind(&slab_id)
    .bind(revision)
    .bind(&group)
    .bind(&calculation)
    .fetch_one(&mut *tx)
    .await
    .map_err(unable)?;
    sqlx::query(
        "INSERT INTO slab_recommendation_evidence(recommendation_id,revision_id) SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(unable)?;
    // `retainEvidenceRevisions`.
    let kept = sqlx::query(
        "UPDATE slab_evidence_revisions SET retained = true WHERE id = ANY($1::uuid[])",
    )
    .bind(&ids)
    .execute(&mut *tx)
    .await
    .map_err(unable)?;
    if kept.rows_affected() as usize != ids.len() {
        return Err(unable("evidence expired before it could be retained"));
    }
    tx.commit().await.map_err(unable)?;
    Ok(Calculated {
        id,
        requires_review: ask.requires_review,
        calculation,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::database::Database;

    /// Each case of `.port-logs/slab-calc-cases.json` on `slab-calc-seed.sql`, in one transaction
    /// rolled back, against Node's `calculateSlabRecommendation` at the same time
    /// (`.port-logs/slab-calc-node.ts`): the refusal, the recommendation's input key (the hash of its
    /// calculation as Node writes it), and every recommendation saved with its evidence, and the
    /// revisions kept.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn recommendations_calculate_as_node_calculates_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("slab-calc-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("slab-calc.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let capture = read_log("slab-calc-capture.sql");
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("slab-calc-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(node) {
            let (name, body) = (&case["name"], &case["body"]);
            let policy: Policy = serde_json::from_value(body["policy"].clone()).unwrap();
            let seller: Seller = serde_json::from_value(body["seller"].clone()).unwrap();
            let ids: Vec<String> = serde_json::from_value(body["revisionIds"].clone()).unwrap();
            let asked = Asked {
                slab_id: body["slabId"].as_str().unwrap(),
                identity_revision: body["identityRevision"].as_i64().unwrap(),
                revision_ids: &ids,
                policy: &policy,
                seller: &seller,
                replacing: None,
            };
            let as_of = case["asOf"].as_str().unwrap();
            match calculate(&mut tx, &asked, as_of).await {
                Ok(Calculated { id, .. }) => {
                    let key: String = sqlx::query_scalar(
                        "SELECT input_key FROM slab_recommendations WHERE id = $1::uuid",
                    )
                    .bind(&id)
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                    assert_eq!(Some(key.as_str()), theirs["inputKey"].as_str(), "{name}");
                }
                Err(why) => assert_eq!(Some(why.as_str()), theirs["error"].as_str(), "{name}"),
            }
            let saved: Value = sqlx::query_scalar(capture.as_str())
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(saved, theirs["saved"], "{name}");
        }
        tx.rollback().await.unwrap();
    }
}
