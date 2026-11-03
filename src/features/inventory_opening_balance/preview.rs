//! Previewing an opening balance, ported from `inventoryOpeningBalancesRepository.preview`: a
//! complete inventory observation of the seller's stock becomes a run of opening quantities,
//! `previewed` when nothing stands in its way and `blocked` with the reasons when something does
//! (the observation was unstable, order coverage does not reach its cutoff, a SKU lacks catalog
//! identity, an order or publication happened while it was taken, a change awaits review, or the
//! seller already has an opening balance). The run carries a fingerprint of the evidence it rests
//! on, which applying it checks again. A request is previewed once: its id again is answered with
//! the run it made.
//!
//! Failures are Node's `String(error)`: `Error: ...` for its own, `error: ...` for the
//! database's.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use crate::{
    features::inventory_economics::ledger::{fingerprint::sha256_hex, proceeds::iso},
    node_pg,
};

/// The run a request already made, as Node reads it back.
const EXISTING: &str = r#"SELECT run.id::text AS id,run.seller_key AS "sellerKey",run.observation_id::text AS "observationId",
          run.cutoff_at AS "cutoffAt",run.status,run.evidence_fingerprint AS "evidenceFingerprint",run.unresolved,run.limitations,
          observation.item_count AS "itemCount",observation.positive_item_count AS "positiveItemCount",
          observation.total_quantity AS "observedTotalQuantity",
          observation.supported_positive_sku_count AS "positiveSkuCount",
          observation.supported_total_quantity AS "totalQuantity",
          observation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          observation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
         FROM inventory_opening_balance_runs run
         JOIN inventory_complete_observations observation ON observation.id=run.observation_id
         WHERE run.request_id=$1"#;

/// The complete order sync that first finished after the cutoff, as Node reads it (and saves it).
const COVERAGE: &str = r#"SELECT id::text AS id,finished_at AS "finishedAt",observed_from AS "observedFrom",
          observed_through AS "observedThrough",orders_observed AS "ordersObserved",
          details_recorded AS "detailsRecorded" FROM seller_order_sync_runs
         WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at >= $2
         ORDER BY finished_at ASC LIMIT 1"#;

/// The observation previewed.
#[derive(sqlx::FromRow)]
struct Observation {
    seller_key: String,
    status: String,
    started_at: DateTime<Utc>,
    cutoff_at: DateTime<Utc>,
    quantity_fingerprint: String,
    supported_quantity_fingerprint: String,
    item_count: i32,
    positive_item_count: i32,
    observed_total_quantity: i32,
    positive_sku_count: i32,
    total_quantity: i32,
    unsupported_positive_item_count: i32,
    unsupported_positive_quantity: i32,
}

/// What the observation's saved items say, to check against its counts and fingerprints
/// (`observationItemsEvidence`).
#[derive(Debug, PartialEq, Eq)]
struct ItemsEvidence {
    item_count: i32,
    positive_item_count: i32,
    total_quantity: i32,
    positive_sku_count: i32,
    supported_total_quantity: i32,
    unsupported_positive_item_count: i32,
    unsupported_positive_quantity: i32,
    quantity_fingerprint: String,
    supported_quantity_fingerprint: String,
}

impl Observation {
    fn evidence(&self) -> ItemsEvidence {
        ItemsEvidence {
            item_count: self.item_count,
            positive_item_count: self.positive_item_count,
            total_quantity: self.observed_total_quantity,
            positive_sku_count: self.positive_sku_count,
            supported_total_quantity: self.total_quantity,
            unsupported_positive_item_count: self.unsupported_positive_item_count,
            unsupported_positive_quantity: self.unsupported_positive_quantity,
            quantity_fingerprint: self.quantity_fingerprint.clone(),
            supported_quantity_fingerprint: self.supported_quantity_fingerprint.clone(),
        }
    }
}

/// An observed item: its inventory key, its SKU when it is a standard one, and its quantity.
type Item = (String, Option<i32>, i32);

/// `observationItemsEvidence` of the items, read in inventory key order (`COLLATE "C"`).
fn items_evidence(items: &[Item]) -> ItemsEvidence {
    let count = |keep: &dyn Fn(&Item) -> bool| items.iter().filter(|i| keep(i)).count() as i32;
    let sum =
        |keep: &dyn Fn(&Item) -> bool| items.iter().filter(|i| keep(i)).map(|i| i.2).sum::<i32>();
    let mut supported: Vec<(i32, i32)> = items
        .iter()
        .filter_map(|(_, sku, quantity)| sku.map(|sku| (sku, *quantity)))
        .collect();
    // A stable sort by SKU, as JavaScript's.
    supported.sort_by_key(|(sku, _)| *sku);
    let keyed: Vec<(&str, i32)> = items.iter().map(|(key, _, q)| (key.as_str(), *q)).collect();
    ItemsEvidence {
        item_count: items.len() as i32,
        positive_item_count: count(&|i| i.2 > 0),
        total_quantity: sum(&|_| true),
        positive_sku_count: count(&|i| i.1.is_some() && i.2 > 0),
        supported_total_quantity: sum(&|i| i.1.is_some()),
        unsupported_positive_item_count: count(&|i| i.1.is_none() && i.2 > 0),
        unsupported_positive_quantity: sum(&|i| i.1.is_none()),
        quantity_fingerprint: sha256_hex(&serde_json::to_string(&keyed).expect("text and numbers")),
        supported_quantity_fingerprint: sha256_hex(
            &serde_json::to_string(&supported).expect("numbers"),
        ),
    }
}

/// `String(error)` of an `Error` Node threw.
fn thrown(message: &str) -> String {
    format!("Error: {message}")
}

/// `preview`: the run `request_id` made of `observation_id` for `seller`, made now if it is new.
pub async fn preview(
    conn: &mut PgConnection,
    request_id: &str,
    seller: &str,
    observation_id: &str,
) -> Result<Value, String> {
    let mut tx = conn.begin().await.map_err(node_pg::thrown)?;
    let answer = previewed(&mut tx, request_id, seller, observation_id).await?;
    tx.commit().await.map_err(node_pg::thrown)?;
    Ok(answer)
}

async fn previewed(
    db: &mut PgConnection,
    request_id: &str,
    seller: &str,
    observation_id: &str,
) -> Result<Value, String> {
    let failed = node_pg::thrown;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("opening:{seller}"))
        .execute(&mut *db)
        .await
        .map_err(failed)?;
    let existing = sqlx::query(EXISTING)
        .bind(request_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(failed)?;
    if let Some(existing) = existing {
        let existing = node_pg::row(&existing)?;
        if existing["sellerKey"] != seller || existing["observationId"] != observation_id {
            return Err(thrown(
                "Opening preview request ID was reused with different inputs.",
            ));
        }
        return Ok(existing);
    }
    let observation: Option<Observation> = sqlx::query_as(OBSERVATION)
        .bind(observation_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(failed)?;
    let Some(observation) = observation.filter(|o| o.seller_key == seller) else {
        return Err(thrown(
            "Complete inventory observation does not match seller.",
        ));
    };
    if !items_agree(db, &observation, observation_id).await? {
        return Err(thrown(
            "Complete inventory observation item evidence is unavailable or inconsistent.",
        ));
    }
    sqlx::query(
        "SELECT skus.sku FROM skus
         JOIN inventory_complete_observation_items item ON item.sku=skus.sku
         WHERE item.observation_id=$1::bigint AND item.quantity>0 FOR SHARE OF skus",
    )
    .bind(observation_id)
    .execute(&mut *db)
    .await
    .map_err(failed)?;
    let coverage = sqlx::query(COVERAGE)
        .bind(seller)
        .bind(observation.cutoff_at)
        .fetch_optional(&mut *db)
        .await
        .map_err(failed)?
        .map(|row| node_pg::row(&row))
        .transpose()?;
    let coverage_id = coverage
        .as_ref()
        .map(|c| c["id"].clone())
        .unwrap_or(Value::Null);
    let count = |sql: &'static str| sqlx::query_scalar::<_, i32>(sql);
    let missing = count(
        "SELECT COUNT(*)::int FROM inventory_complete_observation_items item
         LEFT JOIN skus ON skus.sku=item.sku
         WHERE item.observation_id=$1::bigint AND item.sku IS NOT NULL AND item.quantity>0
           AND (skus.sku IS NULL OR skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL)",
    )
    .bind(observation_id)
    .fetch_one(&mut *db)
    .await
    .map_err(failed)?;
    let interval_orders = count(
        "SELECT COUNT(*)::int FROM seller_orders WHERE seller_key=$1 AND order_time >= $2 AND order_time < $3",
    )
    .bind(seller)
    .bind(observation.started_at)
    .bind(observation.cutoff_at)
    .fetch_one(&mut *db)
    .await
    .map_err(failed)?;
    let interval_publications = count(
        "SELECT COUNT(*)::int FROM inventory_publication_receipt_links
         WHERE target_seller_key=$1 AND live_at >= $2 AND live_at < $3",
    )
    .bind(seller)
    .bind(observation.started_at)
    .bind(observation.cutoff_at)
    .fetch_one(&mut *db)
    .await
    .map_err(failed)?;
    let differences = |sku: &'static str| {
        count(if sku == "known" {
            "SELECT COUNT(*)::int FROM inventory_observation_differences
             WHERE observation_id=$1::bigint AND status='unresolved' AND sku IS NOT NULL"
        } else {
            "SELECT COUNT(*)::int FROM inventory_observation_differences
             WHERE observation_id=$1::bigint AND status='unresolved' AND sku IS NULL"
        })
    };
    let unresolved_differences = differences("known")
        .bind(observation_id)
        .fetch_one(&mut *db)
        .await
        .map_err(failed)?;
    let unsupported_differences = differences("unsupported")
        .bind(observation_id)
        .fetch_one(&mut *db)
        .await
        .map_err(failed)?;
    let applied_opening = count(
        "SELECT COUNT(*)::int FROM inventory_opening_balance_runs WHERE seller_key=$1 AND status='applied'",
    )
    .bind(seller)
    .fetch_one(&mut *db)
    .await
    .map_err(failed)?;

    let mut unresolved: Vec<String> = Vec::new();
    if observation.status != "complete" {
        unresolved.push("Inventory quantities changed during observation.".into());
    }
    if coverage.is_none() {
        unresolved.push("Complete seller order coverage through the cutoff is required.".into());
    }
    if missing > 0 {
        unresolved.push(format!(
            "{missing} positive inventory SKUs lack catalog identity."
        ));
    }
    if interval_orders > 0 {
        unresolved.push("An order occurred during the inventory observation interval.".into());
    }
    if interval_publications > 0 {
        unresolved
            .push("A publication became live during the inventory observation interval.".into());
    }
    if unresolved_differences > 0 {
        unresolved.push(format!(
            "{unresolved_differences} inventory changes require review."
        ));
    }
    if applied_opening > 0 {
        unresolved.push("This seller already has an applied opening balance.".into());
    }
    let mut limitations: Vec<String> = Vec::new();
    if observation.unsupported_positive_item_count > 0 {
        limitations.push(format!(
            "{} unsupported positive inventory items ({} units) are preserved as evidence and excluded from this standard-SKU opening balance.",
            observation.unsupported_positive_item_count, observation.unsupported_positive_quantity
        ));
    }
    if unsupported_differences > 0 {
        limitations.push(format!(
            "{unsupported_differences} unsupported inventory identity changes remain unavailable to FIFO."
        ));
    }

    let source_evidence =
        source_evidence(db, seller, observation.cutoff_at, observation_id).await?;
    let fingerprint = evidence_fingerprint(
        Some(&observation.supported_quantity_fingerprint),
        Some(&coverage_id),
        &source_evidence,
    );
    let status = if unresolved.is_empty() {
        "previewed"
    } else {
        "blocked"
    };
    let (unresolved, limitations) = (json!(unresolved), json!(limitations));
    let (id, status): (String, String) = sqlx::query_as(
        "INSERT INTO inventory_opening_balance_runs
          (request_id,seller_key,observation_id,order_coverage_run_id,order_coverage_evidence,cutoff_at,status,evidence_fingerprint,unresolved,limitations)
         VALUES ($1,$2,$3::bigint,$4::bigint,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING id::text,status",
    )
    .bind(request_id)
    .bind(seller)
    .bind(observation_id)
    .bind(coverage_id.as_str())
    .bind(coverage.unwrap_or(Value::Null).to_string())
    .bind(observation.cutoff_at)
    .bind(status)
    .bind(&fingerprint)
    .bind(unresolved.to_string())
    .bind(limitations.to_string())
    .fetch_one(&mut *db)
    .await
    .map_err(failed)?;
    sqlx::query(
        "INSERT INTO inventory_opening_balance_items
          (run_id,sku,opening_quantity,product_line_id,set_id,product_id)
         SELECT $1::bigint,item.sku,item.quantity,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.product_line_id END,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.set_id END,
           CASE WHEN skus.product_line_id IS NULL OR skus.set_id IS NULL OR skus.product_id IS NULL THEN NULL ELSE skus.product_id END
         FROM inventory_complete_observation_items item
         LEFT JOIN skus ON skus.sku=item.sku
         WHERE item.observation_id=$2::bigint AND item.sku IS NOT NULL AND item.quantity>0",
    )
    .bind(&id)
    .bind(observation_id)
    .execute(&mut *db)
    .await
    .map_err(failed)?;
    Ok(json!({
        "id": id,
        "status": status,
        "cutoffAt": iso(observation.cutoff_at),
        "evidenceFingerprint": fingerprint,
        "unresolved": unresolved,
        "limitations": limitations,
        "itemCount": observation.item_count,
        "positiveItemCount": observation.positive_item_count,
        "observedTotalQuantity": observation.observed_total_quantity,
        "positiveSkuCount": observation.positive_sku_count,
        "totalQuantity": observation.total_quantity,
        "unsupportedPositiveItemCount": observation.unsupported_positive_item_count,
        "unsupportedPositiveQuantity": observation.unsupported_positive_quantity,
    }))
}

/// An observation's counts and fingerprints.
const OBSERVATION: &str = r#"SELECT seller_key,status,cutoff_at,started_at,quantity_fingerprint,supported_quantity_fingerprint,
          item_count,positive_item_count,total_quantity AS observed_total_quantity,
          supported_positive_sku_count AS positive_sku_count,supported_total_quantity AS total_quantity,
          unsupported_positive_item_count,unsupported_positive_quantity
         FROM inventory_complete_observations WHERE id=$1::bigint"#;

/// Whether the observation's saved items say what its counts and fingerprints say.
async fn items_agree(
    db: &mut PgConnection,
    observation: &Observation,
    observation_id: &str,
) -> Result<bool, String> {
    let items: Vec<Item> = sqlx::query_as(
        r#"SELECT inventory_key,sku,quantity FROM inventory_complete_observation_items
         WHERE observation_id=$1::bigint ORDER BY inventory_key COLLATE "C""#,
    )
    .bind(observation_id)
    .fetch_all(&mut *db)
    .await
    .map_err(node_pg::thrown)?;
    Ok(items_evidence(&items) == observation.evidence())
}

/// Whether observation `observation_id` is there and its saved items agree with it.
pub(super) async fn observation_items_consistent(
    db: &mut PgConnection,
    observation_id: &str,
) -> Result<bool, String> {
    let observation: Option<Observation> = sqlx::query_as(OBSERVATION)
        .bind(observation_id)
        .fetch_optional(&mut *db)
        .await
        .map_err(node_pg::thrown)?;
    match observation {
        Some(observation) => items_agree(db, &observation, observation_id).await,
        None => Ok(false),
    }
}

/// The run's evidence fingerprint: `JSON.stringify({observation, orderCoverage, sourceEvidence})`
/// hashed, a key that is `undefined` left out.
pub(super) fn evidence_fingerprint(
    observation: Option<&str>,
    coverage: Option<&Value>,
    source_evidence: &str,
) -> String {
    let mut fields = Vec::new();
    if let Some(observation) = observation {
        fields.push(format!(r#""observation":{}"#, Value::from(observation)));
    }
    if let Some(coverage) = coverage {
        fields.push(format!(r#""orderCoverage":{coverage}"#));
    }
    fields.push(format!(
        r#""sourceEvidence":{}"#,
        Value::from(source_evidence)
    ));
    sha256_hex(&format!("{{{}}}", fields.join(",")))
}

/// A positive SKU and its product line, set and product, any of which the catalog may lack.
type CatalogIdentity = (i32, Option<i32>, Option<i32>, Option<i32>);

/// `evidence`: the fingerprint of what the opening balance rests on besides the observation:
/// the seller's orders before the cutoff (and their revisions), the publications live before it,
/// and the catalog identity of each positive SKU.
pub(super) async fn source_evidence(
    db: &mut PgConnection,
    seller: &str,
    cutoff_at: DateTime<Utc>,
    observation_id: &str,
) -> Result<String, String> {
    let orders: Vec<(String, i32)> = sqlx::query_as(
        "SELECT id::text, source_revision FROM seller_orders
         WHERE seller_key=$1 AND order_time < $2 ORDER BY id",
    )
    .bind(seller)
    .bind(cutoff_at)
    .fetch_all(&mut *db)
    .await
    .map_err(node_pg::thrown)?;
    let receipts: Vec<(i32, DateTime<Utc>, i32)> = sqlx::query_as(
        "SELECT link.receipt_id, link.live_at, link.planned_quantity
         FROM inventory_publication_receipt_links link
         WHERE link.target_seller_key=$1 AND link.live_at < $2 ORDER BY link.receipt_id",
    )
    .bind(seller)
    .bind(cutoff_at)
    .fetch_all(&mut *db)
    .await
    .map_err(node_pg::thrown)?;
    let catalog: Vec<CatalogIdentity> = sqlx::query_as(
        "SELECT item.sku, skus.product_line_id, skus.set_id, skus.product_id
         FROM inventory_complete_observation_items item
         LEFT JOIN skus ON skus.sku=item.sku
         WHERE item.observation_id=$1::bigint AND item.sku IS NOT NULL AND item.quantity>0
         ORDER BY item.sku",
    )
    .bind(observation_id)
    .fetch_all(&mut *db)
    .await
    .map_err(node_pg::thrown)?;
    let receipts: Vec<(i32, i32, String)> = receipts
        .into_iter()
        .map(|(id, live_at, quantity)| (id, quantity, iso(live_at)))
        .collect();
    // Written field by field: `JSON.stringify` keeps the object's order.
    Ok(sha256_hex(&format!(
        r#"{{"orders":{},"receipts":{},"catalog":{}}}"#,
        json!(orders),
        json!(receipts),
        json!(catalog)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node: `JSON.stringify([["a",2],["b",0]])` and `JSON.stringify([[5,0],[7,2]])` hashed.
    #[test]
    fn items_are_fingerprinted_as_node_fingerprints_them() {
        let items: Vec<Item> = vec![
            ("b".into(), Some(7), 2),
            ("c".into(), None, 3),
            ("a".into(), Some(5), 0),
        ];
        let evidence = items_evidence(&items);
        assert_eq!(evidence.item_count, 3);
        assert_eq!(evidence.positive_item_count, 2);
        assert_eq!(evidence.positive_sku_count, 1);
        assert_eq!(evidence.supported_total_quantity, 2);
        assert_eq!(evidence.unsupported_positive_item_count, 1);
        assert_eq!(evidence.unsupported_positive_quantity, 3);
        assert_eq!(
            evidence.quantity_fingerprint,
            sha256_hex(r#"[["b",2],["c",3],["a",0]]"#)
        );
        assert_eq!(
            evidence.supported_quantity_fingerprint,
            sha256_hex("[[5,0],[7,2]]")
        );
    }
}
