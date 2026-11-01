//! What an operator reads of FIFO (`inventoryFifoRepository`'s `findOrderAllocation`,
//! `listLineRevisions`, `listHolds`), with Node's queries as it wrote them, so the answers are
//! its own (`crate::node_pg`). An error is what the Node route answered, `String(error)`.
use serde_json::{Value, json};

use crate::{database::Database, node_pg};

const ORDER_ALLOCATION: &str = r#"WITH target_order AS (
        SELECT * FROM seller_orders WHERE seller_key=$1 AND order_number=$2
      ), identities AS (
        SELECT current_line.sku_id AS "skuId" FROM seller_order_lines current_line JOIN target_order ON target_order.id=current_line.order_id
        UNION SELECT saved.order_line_sku_id FROM inventory_fifo_lines saved JOIN target_order ON target_order.id=saved.order_id
      ) SELECT line.id::text AS id,identities."skuId",COALESCE(line.sku,CASE
        WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN identities."skuId"::integer END) AS sku,
      COALESCE(line.state,CASE WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
        AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN 'pending' ELSE 'unsupported' END) AS state,
      line.hold_reason AS "holdReason",COALESCE(line.ordered_quantity,current_line.ordered_quantity,0)::int AS "orderedQuantity",
      COALESCE(current_line.ordered_quantity,0)::int AS "currentOrderedQuantity",
      COALESCE(line.matched_quantity,0)::int AS "matchedQuantity",
      COALESCE(line.unmatched_quantity,current_line.ordered_quantity,0)::int AS "unmatchedQuantity",
      COALESCE(line.price_known_quantity,0)::int AS "priceKnownQuantity",
      COALESCE(line.date_known_quantity,0)::int AS "dateKnownQuantity",
      line.intake_market_total::float8 AS "intakeMarketTotal",line.weighted_days_held::float8 AS "weightedDaysHeld",
      line.current_revision_id::text AS "revisionId",orders.source_revision AS "sourceOrderRevision",
      line.source_order_revision AS "allocatedSourceOrderRevision",queue.status AS "replayStatus",
      ((line.id IS NULL AND identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647)
        OR queue.generation IS NOT NULL OR line.source_order_revision<>orders.source_revision) AS "allocationPending",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('supplyKey',allocation.supply_key,
        'receiptId',allocation.receipt_id,'dispositionId',allocation.disposition_id::text,
        'quantityCorrectionId',allocation.quantity_correction_id::text,
        'quantity',allocation.allocated_quantity,'availableAt',allocation.available_at) ORDER BY allocation.supply_key)
        FROM inventory_fifo_revision_allocations allocation WHERE allocation.revision_id=line.current_revision_id),'[]'::jsonb) AS allocations
      FROM target_order orders CROSS JOIN identities
      LEFT JOIN seller_order_lines current_line ON current_line.order_id=orders.id AND current_line.sku_id=identities."skuId"
      LEFT JOIN inventory_fifo_lines line ON line.order_id=orders.id AND line.order_line_sku_id=identities."skuId"
      LEFT JOIN inventory_fifo_replay_queue queue ON queue.seller_key=orders.seller_key AND queue.sku=COALESCE(line.sku,CASE
        WHEN identities."skuId"~'^[1-9][0-9]{0,9}$'
          AND identities."skuId"::bigint BETWEEN 1 AND 2147483647 THEN identities."skuId"::integer END)
      ORDER BY identities."skuId""#;

const LINE_REVISIONS: &str = r#"SELECT revision.id::text AS id,revision.revision_number AS "revisionNumber",
      revision.source_order_revision AS "sourceOrderRevision",revision.order_time AS "orderTime",
      revision.trigger_reason AS "triggerReason",revision.state,revision.hold_reason AS "holdReason",
      revision.ordered_quantity AS "orderedQuantity",revision.matched_quantity AS "matchedQuantity",
      revision.unmatched_quantity AS "unmatchedQuantity",revision.price_known_quantity AS "priceKnownQuantity",
      revision.date_known_quantity AS "dateKnownQuantity",revision.intake_market_total::float8 AS "intakeMarketTotal",
      revision.weighted_days_held::float8 AS "weightedDaysHeld",revision.recorded_at AS "recordedAt",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('supplyKey',allocation.supply_key,
        'receiptId',allocation.receipt_id,'dispositionId',allocation.disposition_id::text,
        'quantityCorrectionId',allocation.quantity_correction_id::text,
        'quantity',allocation.allocated_quantity,'availableAt',allocation.available_at) ORDER BY allocation.supply_key)
        FROM inventory_fifo_revision_allocations allocation WHERE allocation.revision_id=revision.id),'[]'::jsonb) AS allocations
      FROM inventory_fifo_revisions revision JOIN inventory_fifo_lines line ON line.id=revision.line_id
      WHERE line.id=$1::bigint AND line.seller_key=$2 AND revision.revision_number>$3::bigint
      ORDER BY revision.revision_number LIMIT $4::bigint"#;

const QUEUE_HOLDS: &str = r#"SELECT seller_key AS "sellerKey",sku,status,affected_from AS "affectedFrom",
      hold_reason AS "holdReason",updated_at AS "updatedAt"
      FROM inventory_fifo_replay_queue WHERE seller_key=$1 AND sku>$2::bigint ORDER BY sku LIMIT $3::bigint"#;

const LINE_HOLDS: &str = r#"SELECT orders.order_number AS "orderNumber",line.order_line_sku_id AS "skuId",line.sku,
      line.hold_reason AS "holdReason",line.updated_at AS "updatedAt" FROM inventory_fifo_lines line
      JOIN seller_orders orders ON orders.id=line.order_id WHERE line.seller_key=$1 AND line.state='held'
        AND line.sku>$2::bigint ORDER BY line.sku,orders.order_time,orders.order_number,line.order_line_sku_id LIMIT $3::bigint"#;

/// `String(error)` of what node-pg threw: a database's error is named `error`.
fn failed(e: sqlx::Error) -> String {
    match e.as_database_error() {
        Some(database) => format!("error: {}", database.message()),
        None => format!("Error: {e}"),
    }
}

/// `Number.isInteger`.
fn integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// A cursor compared with an `integer` column, which Postgres refuses past the type's range when
/// node-pg sends it.
fn int4(cursor: f64) -> Result<i64, String> {
    if cursor > f64::from(i32::MAX) {
        let written = crate::features::inventory_economics::ledger::fingerprint::js_float(cursor);
        return Err(format!(
            "error: value \"{written}\" is out of range for type integer"
        ));
    }
    Ok(cursor as i64)
}

/// Each of the order's lines, current or once allocated, with its allocation and replay state.
pub async fn order_allocation(db: &Database, seller: &str, order: &str) -> Result<Value, String> {
    let rows = sqlx::query(ORDER_ALLOCATION)
        .bind(seller.trim())
        .bind(order.trim())
        .fetch_all(&db.0)
        .await
        .map_err(failed)?;
    node_pg::rows(&rows)
}

/// A line's earlier revisions after `after` (0 when not given), `limit` (50) at a time.
pub async fn line_revisions(
    db: &Database,
    seller: &str,
    line: &str,
    after: Option<f64>,
    limit: Option<f64>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(50.0);
    if !integer(limit) || !(1.0..=100.0).contains(&limit) {
        return Err("Error: Revision limit must be between 1 and 100.".into());
    }
    let after = after.unwrap_or(0.0);
    if !integer(after) || after < 0.0 {
        return Err("Error: After revision must be a nonnegative integer.".into());
    }
    let rows = sqlx::query(LINE_REVISIONS)
        .bind(line)
        .bind(seller.trim())
        .bind(int4(after)?)
        .bind(limit as i64)
        .fetch_all(&db.0)
        .await
        .map_err(failed)?;
    node_pg::rows(&rows)
}

/// The held SKUs and held lines after the SKU `after` (0 when not given), `limit` (100) of each.
pub async fn holds(
    db: &Database,
    seller: &str,
    after: Option<f64>,
    limit: Option<f64>,
) -> Result<Value, String> {
    let (after, limit) = (after.unwrap_or(0.0), limit.unwrap_or(100.0));
    if !integer(after) || after < 0.0 || !integer(limit) || !(1.0..=200.0).contains(&limit) {
        return Err(
            "Error: FIFO hold page must use a nonnegative SKU cursor and a limit between 1 and 200."
                .into(),
        );
    }
    let after = int4(after)?;
    let page = |sql| {
        sqlx::query(sql)
            .bind(seller.trim())
            .bind(after)
            .bind(limit as i64)
            .fetch_all(&db.0)
    };
    let queue = page(QUEUE_HOLDS).await.map_err(failed)?;
    let lines = page(LINE_HOLDS).await.map_err(failed)?;
    Ok(json!({ "queue": node_pg::rows(&queue)?, "lines": node_pg::rows(&lines)? }))
}
