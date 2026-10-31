//! The replay queue, ported from `inventoryFifoRepository.processNextReplay`: the next queued
//! seller SKU is claimed, replayed ([`replay`]), and either held for a person to reconcile or its
//! changed lines saved as new revisions and the SKU taken off the queue. Node's worker and this
//! one claim from the same queue: a SKU's claim and Node's advisory lock keep one replay at a time.
use serde::Serialize;
use serde_json::json;
use sqlx::{Connection, PgConnection};

use super::replay::{self, Replay, SavedLine, iso};

/// What became of the SKU a replay claimed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Processed {
    Held { sku: i32, reason: String },
    Complete { sku: i32, changed_lines: usize },
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the seller order history worker's cycle calls it once its sync store is ported"
    )
)]
/// Replays the seller's next queued SKU in a transaction of its own on `conn` (a savepoint
/// when `conn` is already in one), or answers none when nothing is queued.
pub async fn process_next(
    conn: &mut PgConnection,
    seller: &str,
) -> Result<Option<Processed>, String> {
    let failed = |e: sqlx::Error| e.to_string();
    let mut tx = conn.begin().await.map_err(failed)?;
    let seller = Some(seller.trim()).filter(|s| !s.is_empty());
    let queued: Option<(String, i32)> = sqlx::query_as(
        "SELECT seller_key,sku FROM inventory_fifo_replay_queue
         WHERE (status='pending' OR (status='processing' AND claim_expires_at<NOW()))
           AND ($1::text IS NULL OR seller_key=$1)
         ORDER BY updated_at,seller_key,sku FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let Some((seller, sku)) = queued else {
        return Ok(None);
    };
    sqlx::query(
        "UPDATE inventory_fifo_replay_queue SET status='processing',claim_token=gen_random_uuid(),
           claim_expires_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE seller_key=$1 AND sku=$2",
    )
    .bind(&seller)
    .bind(sku)
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("fifo:{seller}:{sku}"))
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    let replayed = match replay::load(&mut tx, &seller, sku).await.map_err(failed)? {
        Err(reason) => Replay::Held(reason),
        Ok(inputs) => replay::plan(&inputs).map_err(|e| e.to_string())?,
    };
    let processed = match replayed {
        Replay::Held(reason) => {
            hold(&mut tx, &seller, sku, &reason).await.map_err(failed)?;
            Processed::Held { sku, reason }
        }
        Replay::Saved { lines, held } => {
            let changed_lines = save_lines(&mut tx, sku, &lines, "seller_sku_replay").await?;
            match held {
                Some(reason) => {
                    hold(&mut tx, &seller, sku, &reason).await.map_err(failed)?;
                    Processed::Held { sku, reason }
                }
                None => {
                    sqlx::query(
                        "DELETE FROM inventory_fifo_replay_queue WHERE seller_key=$1 AND sku=$2",
                    )
                    .bind(&seller)
                    .bind(sku)
                    .execute(&mut *tx)
                    .await
                    .map_err(failed)?;
                    Processed::Complete { sku, changed_lines }
                }
            }
        }
    };
    tx.commit().await.map_err(failed)?;
    Ok(Some(processed))
}

async fn hold(conn: &mut PgConnection, seller: &str, sku: i32, reason: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE inventory_fifo_replay_queue SET status='held',claim_token=NULL,claim_expires_at=NULL,
           hold_reason=$3,updated_at=NOW() WHERE seller_key=$1 AND sku=$2",
    )
    .bind(seller)
    .bind(sku)
    .bind(reason)
    .execute(&mut *conn)
    .await
    .map(|_| ())
}

/// `saveLines`: a new revision for each line whose fingerprint differs from its current one,
/// and the line brought up to it. Lines are materialized when their order is recorded, so one
/// missing here is an error. Answers how many lines changed.
pub async fn save_lines(
    conn: &mut PgConnection,
    sku: i32,
    lines: &[SavedLine],
    trigger_reason: &str,
) -> Result<usize, String> {
    let failed = |e: sqlx::Error| e.to_string();
    if lines.is_empty() {
        return Ok(0);
    }
    let identities: Vec<_> = lines
        .iter()
        .map(|line| json!({ "orderId": line.order_id, "skuId": line.sku_id }))
        .collect();
    let current: Vec<(String, String, String, i32, Option<String>)> = sqlx::query_as(
        r#"SELECT line.id::text,line.order_id::text,line.order_line_sku_id,
             COALESCE(revision.revision_number,0)::int,revision.source_fingerprint
           FROM inventory_fifo_lines line LEFT JOIN inventory_fifo_revisions revision ON revision.id=line.current_revision_id
           JOIN jsonb_to_recordset($1::jsonb) AS x("orderId" text,"skuId" text)
             ON line.order_id=x."orderId"::bigint AND line.order_line_sku_id=x."skuId"
           FOR UPDATE OF line"#,
    )
    .bind(serde_json::Value::Array(identities).to_string())
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    let mut changed = Vec::new();
    for line in lines {
        let Some((line_id, _, _, revision_number, saved)) = current
            .iter()
            .find(|(_, order, sku_id, _, _)| *order == line.order_id && *sku_id == line.sku_id)
        else {
            return Err("Failed to materialize FIFO line.".into());
        };
        let fingerprint = replay::fingerprint(line);
        if saved.as_deref() == Some(fingerprint.as_str()) {
            continue;
        }
        changed.push(json!({
            "lineId": line_id,
            "revisionNumber": revision_number + 1,
            "sku": sku,
            "sourceOrderRevision": line.source_order_revision,
            "orderTime": iso(line.order_time),
            "state": line.state,
            "holdReason": line.hold_reason,
            "orderedQuantity": line.ordered_quantity,
            "matchedQuantity": line.matched_quantity,
            "unmatchedQuantity": line.unmatched_quantity,
            "priceKnownQuantity": line.price_known_quantity,
            "dateKnownQuantity": line.date_known_quantity,
            "intakeMarketTotal": line.intake_market_total,
            "weightedDaysHeld": line.weighted_days_held,
            "fingerprint": fingerprint,
            "allocations": line.allocations.iter().map(|a| json!({
                "supplyKey": a.supply_key,
                "receiptId": a.receipt_id,
                "dispositionId": a.disposition_id,
                "quantityCorrectionId": a.quantity_correction_id,
                "quantity": a.quantity,
                "availableAt": iso(a.available_at),
            })).collect::<Vec<_>>(),
        }));
    }
    if changed.is_empty() {
        return Ok(0);
    }
    let revisions: Vec<(String, String)> = sqlx::query_as(
        r#"INSERT INTO inventory_fifo_revisions
             (line_id,revision_number,source_order_revision,order_time,trigger_reason,state,hold_reason,ordered_quantity,
              matched_quantity,unmatched_quantity,price_known_quantity,date_known_quantity,intake_market_total,
              weighted_days_held,source_fingerprint)
           SELECT x."lineId"::bigint,x."revisionNumber",x."sourceOrderRevision",x."orderTime"::timestamptz,$2,x.state,
             x."holdReason",x."orderedQuantity",x."matchedQuantity",x."unmatchedQuantity",x."priceKnownQuantity",
             x."dateKnownQuantity",x."intakeMarketTotal"::numeric,x."weightedDaysHeld"::numeric,x.fingerprint
           FROM jsonb_to_recordset($1::jsonb) AS x("lineId" text,"revisionNumber" integer,"sourceOrderRevision" integer,
             "orderTime" text,state text,"holdReason" text,"orderedQuantity" integer,"matchedQuantity" integer,
             "unmatchedQuantity" integer,"priceKnownQuantity" integer,"dateKnownQuantity" integer,
             "intakeMarketTotal" text,"weightedDaysHeld" text,fingerprint text)
           RETURNING id::text,line_id::text"#,
    )
    .bind(serde_json::Value::Array(changed.clone()).to_string())
    .bind(trigger_reason)
    .fetch_all(&mut *conn)
    .await
    .map_err(failed)?;
    for line in &mut changed {
        let revision = revisions
            .iter()
            .find(|(_, line_id)| line["lineId"] == line_id.as_str())
            .map(|(id, _)| id.clone());
        line["revisionId"] = json!(revision);
    }
    let allocations: Vec<_> = changed
        .iter()
        .flat_map(|line| {
            line["allocations"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|allocation| {
                    let mut allocation = allocation.clone();
                    allocation["revisionId"] = line["revisionId"].clone();
                    allocation
                })
        })
        .collect();
    if !allocations.is_empty() {
        sqlx::query(
            r#"INSERT INTO inventory_fifo_revision_allocations
                 (revision_id,supply_key,receipt_id,disposition_id,quantity_correction_id,allocated_quantity,available_at)
               SELECT x."revisionId"::bigint,x."supplyKey",x."receiptId",x."dispositionId"::bigint,
                 x."quantityCorrectionId"::bigint,x.quantity,x."availableAt"::timestamptz
               FROM jsonb_to_recordset($1::jsonb) AS x("revisionId" text,"supplyKey" text,"receiptId" integer,
                 "dispositionId" text,"quantityCorrectionId" text,quantity integer,"availableAt" text)"#,
        )
        .bind(serde_json::Value::Array(allocations).to_string())
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    }
    sqlx::query(
        r#"UPDATE inventory_fifo_lines line SET sku=x.sku,order_time=x."orderTime"::timestamptz,
             ordered_quantity=x."orderedQuantity",source_order_revision=x."sourceOrderRevision",state=x.state,
             hold_reason=x."holdReason",matched_quantity=x."matchedQuantity",unmatched_quantity=x."unmatchedQuantity",
             price_known_quantity=x."priceKnownQuantity",date_known_quantity=x."dateKnownQuantity",
             intake_market_total=x."intakeMarketTotal"::numeric,weighted_days_held=x."weightedDaysHeld"::numeric,
             current_revision_id=x."revisionId"::bigint,updated_at=NOW()
           FROM jsonb_to_recordset($1::jsonb) AS x("lineId" text,sku integer,"orderTime" text,"orderedQuantity" integer,
             "sourceOrderRevision" integer,state text,"holdReason" text,"matchedQuantity" integer,"unmatchedQuantity" integer,
             "priceKnownQuantity" integer,"dateKnownQuantity" integer,"intakeMarketTotal" text,"weightedDaysHeld" text,"revisionId" text)
           WHERE line.id=x."lineId"::bigint"#,
    )
    .bind(serde_json::Value::Array(changed.clone()).to_string())
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    Ok(changed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;

    /// Replays the worker's cycle (25 SKUs) on the dev database in a transaction it rolls back,
    /// from the scenario `.port-logs/fifo-setup.sql` queues, and compares what it wrote
    /// (`.port-logs/fifo-capture.sql`) with what Node's `processNextReplay` wrote from the same
    /// scenario (`.port-logs/fifo-queue-node.ts`).
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn replays_the_queue_as_node_does() {
        crate::config::load_env();
        let node: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/fifo-queue.node.json").unwrap(),
        )
        .unwrap();
        let setup = std::fs::read_to_string(".port-logs/fifo-setup.sql").unwrap();
        let capture = std::fs::read_to_string(".port-logs/fifo-capture.sql").unwrap();
        let db = Database::connect_lazy(&crate::config::database_url());
        let seller = crate::features::shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&setup).execute(&mut *tx).await.unwrap();
        let mut processed = Vec::new();
        while processed.len() < 25 {
            match process_next(&mut tx, seller.trim()).await.unwrap() {
                Some(one) => processed.push(one),
                None => break,
            }
        }
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let captured: serde_json::Value = serde_json::from_str(&captured).unwrap();
        println!(
            "{} replayed; {} revisions, {} allocations",
            processed.len(),
            captured["revisions"].as_array().map_or(0, Vec::len),
            captured["allocations"].as_array().map_or(0, Vec::len),
        );
        assert_eq!(serde_json::to_value(&processed).unwrap(), node["processed"]);
        assert_eq!(captured, node["captured"]);
    }
}
