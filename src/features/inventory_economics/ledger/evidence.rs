//! What the ledger reads about a seller's orders: the most recent orders with their transaction
//! and refund records, the postage bought for them, the FIFO allocations of every receipt those
//! orders drew from, and the order expenses that name them. The same queries as the Node app's
//! `inventoryEconomicsRepository.findWorkspaceEvidence`; each reads one row past its fence so
//! the ledger knows when it has not seen everything.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::types::Json;

use super::order::Provenance;
use crate::database::Database;

/// Rows read past this many are not read; the evidence says it is incomplete.
pub const FENCE: i64 = 10_000;

/// A captured order, its money in cents as recorded (none where the provider has not said).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct OrderRow {
    pub id: i64,
    pub order_number: String,
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub order_time: DateTime<Utc>,
    pub currency: String,
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub source_fingerprint: String,
    pub lifecycle: String,
    pub transaction_evidence: Option<Json<Value>>,
    pub ordered_quantity: i64,
    pub gross_item_cents: i64,
    pub gross_shipping_cents: Option<i64>,
    pub gross_order_cents: Option<i64>,
    pub platform_fee_cents: Option<i64>,
    pub provider_net_cents: Option<i64>,
    pub direct_fee_cents: Option<i64>,
    pub refunds: Option<Json<Value>>,
}

impl OrderRow {
    pub fn canceled(&self) -> bool {
        self.lifecycle == "canceled"
    }

    /// The transaction and refund records, as JSON (`null` where there are none).
    pub fn transaction(&self) -> Value {
        self.transaction_evidence
            .as_ref()
            .map_or(Value::Null, |j| j.0.clone())
    }

    pub fn refund_records(&self) -> Value {
        self.refunds.as_ref().map_or(Value::Null, |j| j.0.clone())
    }
}

/// A label bought in production for some of these orders.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct PostageRow {
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub id: String,
    pub provider_identity: String,
    pub order_numbers: Vec<String>,
    pub currency: Option<String>,
    pub rate_cents: Option<i64>,
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub direction: String,
    pub linked_sellers: Vec<String>,
    pub linked_order_count: i64,
}

/// Part of a receipt's stock that an order line drew, and the receipt's current cost.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct AllocationRow {
    pub order_id: i64,
    pub receipt_id: i32,
    pub quantity: i64,
    pub original_quantity: i64,
    pub allocated_cost_cents: Option<i64>,
    pub cost_provenance: Option<String>,
    pub cost_currency: Option<String>,
    pub fifo_state: String,
    pub replay_status: Option<String>,
    pub disposition_id: Option<i64>,
    pub quantity_correction_id: Option<i64>,
}

/// The current version of an order expense that names one of these orders.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ExpenseRow {
    pub currency: String,
    pub expense_type: String,
    pub amount_cents: i64,
    pub provenance: String,
    pub order_numbers: Vec<String>,
    pub basis: String,
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub evidence_identity: String,
    pub financial_source_fingerprint: Option<String>,
}

impl ExpenseRow {
    pub fn provenance(&self) -> Provenance {
        provenance(&self.provenance)
    }
}

/// `estimated` is estimated; anything else came from a record.
pub fn provenance(value: &str) -> Provenance {
    if value == "estimated" {
        Provenance::Estimated
    } else {
        Provenance::Actual
    }
}

/// Everything the ledger needs for a seller's most recent orders, and whether each part is whole.
#[derive(Clone, Debug, Default)]
pub struct Evidence {
    pub orders: Vec<OrderRow>,
    #[allow(
        dead_code,
        reason = "read by ledger::proceeds, which Inventory Strategy uses next"
    )]
    pub orders_complete: bool,
    pub postage: Vec<PostageRow>,
    pub postage_complete: bool,
    pub allocations: Vec<AllocationRow>,
    pub allocations_complete: bool,
    pub expenses: Vec<ExpenseRow>,
    pub expenses_complete: bool,
}

/// Keeps the first `limit` rows and says whether that was all of them.
fn fenced<T>(mut rows: Vec<T>, limit: i64) -> (Vec<T>, bool) {
    let limit = usize::try_from(limit).unwrap_or(0);
    let complete = rows.len() <= limit;
    rows.truncate(limit);
    (rows, complete)
}

/// The seller's `limit` most recent orders and the evidence about them.
pub async fn find(db: &Database, seller: &str, limit: i64) -> sqlx::Result<Evidence> {
    let seller = seller.trim();
    let orders: Vec<OrderRow> = sqlx::query_as(
        r#"SELECT orders.id,orders.order_number,orders.order_time,orders.currency,
            orders.source_fingerprint,orders.lifecycle,orders.transaction_evidence,
            (SELECT COALESCE(SUM(line.ordered_quantity),0)::bigint FROM seller_order_lines line
             WHERE line.order_id=orders.id) AS ordered_quantity,
            ROUND(orders.gross_item_proceeds*100)::bigint AS gross_item_cents,
            ROUND(orders.gross_shipping_proceeds*100)::bigint AS gross_shipping_cents,
            ROUND(orders.gross_order_proceeds*100)::bigint AS gross_order_cents,
            ROUND(orders.platform_fee_amount*100)::bigint AS platform_fee_cents,
            ROUND(orders.provider_net_proceeds*100)::bigint AS provider_net_cents,
            ROUND(orders.direct_fee_amount*100)::bigint AS direct_fee_cents,
            revision.refund_evidence AS refunds
          FROM seller_orders orders JOIN seller_order_revisions revision
            ON revision.order_id=orders.id AND revision.revision_number=orders.source_revision
          WHERE orders.seller_key=$1 ORDER BY orders.order_time DESC,orders.id DESC LIMIT $2"#,
    )
    .bind(seller)
    .bind(limit + 1)
    .fetch_all(&db.0)
    .await?;
    let (orders, orders_complete) = fenced(orders, limit);
    if orders.is_empty() {
        return Ok(Evidence {
            orders_complete,
            postage_complete: true,
            allocations_complete: true,
            expenses_complete: true,
            ..Evidence::default()
        });
    }
    let numbers: Vec<&str> = orders.iter().map(|o| o.order_number.as_str()).collect();
    let ids: Vec<i64> = orders.iter().map(|o| o.id).collect();

    let postage: Vec<PostageRow> = sqlx::query_as(
        r#"SELECT purchase.id::text AS id,
            COALESCE(purchase.easypost_shipment_id,'row:'||purchase.id::text) AS provider_identity,
            purchase.order_numbers,purchase.selected_rate_currency AS currency,
            CASE WHEN purchase.selected_rate_rate~'^[0-9]+([.][0-9]{1,2})?$'
              THEN ROUND(purchase.selected_rate_rate::numeric*100)::bigint END AS rate_cents,
            purchase.direction,
            ARRAY(SELECT DISTINCT orders.seller_key FROM seller_orders orders
                  WHERE orders.order_number=ANY(purchase.order_numbers)) AS linked_sellers,
            (SELECT COUNT(*) FROM seller_orders orders
             WHERE orders.order_number=ANY(purchase.order_numbers)) AS linked_order_count
          FROM shipping_postage_purchases purchase
          WHERE purchase.mode='production' AND purchase.status='purchased'
            AND purchase.order_numbers && $1::text[]
          ORDER BY purchase.created_at,purchase.id LIMIT $2"#,
    )
    .bind(&numbers)
    .bind(FENCE + 1)
    .fetch_all(&db.0)
    .await?;
    let (postage, postage_complete) = fenced(postage, FENCE);

    let allocations: Vec<AllocationRow> = sqlx::query_as(
        r#"WITH current_entry AS (
            SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id,entry.provenance
            FROM inventory_purchase_cost_entries entry
            ORDER BY entry.series_id,entry.sequence DESC
          ), latest_cost AS (
            SELECT allocation.receipt_id,allocation.allocated_amount_cents,current.provenance,series.currency
            FROM inventory_purchase_receipt_ownership ownership
            JOIN current_entry current ON current.series_id=ownership.series_id
            JOIN inventory_purchase_cost_allocations allocation
              ON allocation.entry_id=current.id AND allocation.receipt_id=ownership.receipt_id
            JOIN inventory_purchase_cost_series series ON series.id=current.series_id
            WHERE series.seller_key=$1
          ) SELECT fifo.order_id,allocation.receipt_id,
            allocation.allocated_quantity::bigint AS quantity,receipt.original_quantity::bigint AS original_quantity,
            latest_cost.allocated_amount_cents::bigint AS allocated_cost_cents,
            latest_cost.provenance AS cost_provenance,latest_cost.currency AS cost_currency,
            fifo.state AS fifo_state,replay.status AS replay_status,
            allocation.disposition_id::bigint AS disposition_id,
            allocation.quantity_correction_id::bigint AS quantity_correction_id
          FROM inventory_fifo_lines fifo
          JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=fifo.current_revision_id
          JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
          LEFT JOIN latest_cost ON latest_cost.receipt_id=allocation.receipt_id
          LEFT JOIN inventory_fifo_replay_queue replay ON replay.seller_key=fifo.seller_key AND replay.sku=fifo.sku
          WHERE allocation.receipt_id IN (
            SELECT recent_allocation.receipt_id FROM inventory_fifo_lines recent_fifo
            JOIN inventory_fifo_revision_allocations recent_allocation
              ON recent_allocation.revision_id=recent_fifo.current_revision_id
            WHERE recent_fifo.order_id=ANY($2::bigint[])
          ) LIMIT $3"#,
    )
    .bind(seller)
    .bind(&ids)
    .bind(FENCE + 1)
    .fetch_all(&db.0)
    .await?;
    let (allocations, allocations_complete) = fenced(allocations, FENCE);

    let expenses: Vec<ExpenseRow> = sqlx::query_as(
        r#"SELECT series.currency,entry.expense_type,entry.amount_cents::bigint AS amount_cents,entry.provenance,
            entry.order_numbers,entry.basis,entry.request_fingerprint AS evidence_identity,
            entry.financial_source_fingerprint
          FROM inventory_order_expense_series series
          JOIN LATERAL (SELECT * FROM inventory_order_expense_entries candidate WHERE candidate.series_id=series.id
            ORDER BY sequence DESC LIMIT 1) entry ON true
          WHERE series.seller_key=$1 AND entry.order_numbers && $2::text[]
          ORDER BY entry.expense_at,entry.id LIMIT $3"#,
    )
    .bind(seller)
    .bind(&numbers)
    .bind(FENCE + 1)
    .fetch_all(&db.0)
    .await?;
    let (expenses, expenses_complete) = fenced(expenses, FENCE);

    Ok(Evidence {
        orders,
        orders_complete,
        postage,
        postage_complete,
        allocations,
        allocations_complete,
        expenses,
        expenses_complete,
    })
}

/// A purchase's cost as most recently recorded, among the seller's `limit` most recently
/// recorded purchases (`listPurchaseCosts`, current versions only: the screen shows no history).
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct PurchaseCostRow {
    pub id: String,
    pub purchase_reference: String,
    pub currency: String,
    pub total_amount_cents: i64,
    pub provenance: String,
    pub source: String,
    pub allocation_rule: String,
    pub batch_numbers: Vec<i32>,
    pub purchased_at: Option<String>,
}

pub async fn current_purchase_costs(
    db: &Database,
    seller: &str,
    limit: i64,
) -> sqlx::Result<Vec<PurchaseCostRow>> {
    sqlx::query_as(
        r#"WITH selected_series AS (
            SELECT series.id,MAX(entry.recorded_at) AS latest_recorded_at
            FROM inventory_purchase_cost_series series
            JOIN inventory_purchase_cost_entries entry ON entry.series_id=series.id
            WHERE series.seller_key=$1 GROUP BY series.id
            ORDER BY latest_recorded_at DESC,series.id DESC LIMIT $2
          )
          SELECT entry.id::text AS id,series.purchase_reference,series.currency,
            entry.total_amount_cents::bigint AS total_amount_cents,entry.provenance,entry.source,
            entry.allocation_rule,entry.batch_numbers,entry.purchased_at::text AS purchased_at
          FROM selected_series selected
          JOIN inventory_purchase_cost_series series ON series.id=selected.id
          JOIN LATERAL (SELECT * FROM inventory_purchase_cost_entries candidate
            WHERE candidate.series_id=series.id ORDER BY candidate.sequence DESC LIMIT 1) entry ON true
          ORDER BY selected.latest_recorded_at DESC,series.id DESC"#,
    )
    .bind(seller.trim())
    .bind(limit)
    .fetch_all(&db.0)
    .await
}
