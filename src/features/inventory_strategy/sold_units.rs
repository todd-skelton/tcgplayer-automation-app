//! Every sold unit under a current FIFO allocation, at its share of its order's net proceeds and
//! its lot's current cost: the Node app's `findSoldUnits` and `loadSoldUnitLines`.
use std::collections::HashMap;

use chrono::{DateTime, Utc};

use super::performance::{SoldUnitLine, days_between};
use crate::{
    database::Database,
    features::inventory_economics::ledger::{
        assumptions::js_round, evidence, orders::calculate_orders,
    },
};

/// Days a weekly market price stays current for the sale it is compared with.
const SALE_MARKET_LOOKBACK_DAYS: i32 = 35;

/// Unit market value of a receipt lot (alias `receipt`, seller as `$1`): the market price
/// observed at intake, else the SKU's latest weekly market price on or before intake (or before
/// the seller's inventory was first observed, for lots without an intake), else its current
/// market price, else the seller's own listed price. Estimated costs and margin drivers share it.
pub const LOT_MARKET_VALUE_SQL: &str = "COALESCE(receipt.market_value,
  (SELECT weekly.tcg_market_price FROM product_weekly_sales weekly
   WHERE weekly.sku_id=receipt.sku AND weekly.tcg_market_price IS NOT NULL
     AND weekly.week_start<=COALESCE(receipt.intake_at::date,
       (SELECT observed.created_at::date FROM continuous_pricing_inventory observed
        WHERE observed.seller_key=$1 AND observed.sku=receipt.sku))
   ORDER BY weekly.week_start DESC LIMIT 1),
  (SELECT observed.market_price FROM continuous_pricing_inventory observed
   WHERE observed.seller_key=$1 AND observed.sku=receipt.sku AND observed.market_price IS NOT NULL LIMIT 1),
  (SELECT observed.current_price FROM continuous_pricing_inventory observed
   WHERE observed.seller_key=$1 AND observed.sku=receipt.sku AND observed.current_price IS NOT NULL LIMIT 1))";

#[derive(Debug, sqlx::FromRow)]
struct SoldUnitRow {
    order_number: String,
    sold_at: DateTime<Utc>,
    product_line: String,
    quantity: i64,
    gross_cents: i64,
    order_gross_cents: i64,
    cost_cents: Option<i64>,
    held_since: DateTime<Utc>,
    intake_market_cents: Option<i64>,
    sale_market_cents: Option<i64>,
}

async fn sold_units(db: &Database, seller: &str) -> sqlx::Result<Vec<SoldUnitRow>> {
    let sql = format!(
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
            WHERE series.seller_key=$1 AND series.currency='USD'
          ) SELECT orders.order_number,orders.order_time AS sold_at,
            COALESCE(product_line.product_line_name,'Product line '||receipt.product_line_id) AS product_line,
            allocation.allocated_quantity::bigint AS quantity,
            ROUND(line.gross_item_proceeds*100*allocation.allocated_quantity/line.ordered_quantity)::bigint AS gross_cents,
            ROUND(orders.gross_item_proceeds*100)::bigint AS order_gross_cents,
            CASE WHEN latest_cost.receipt_id IS NULL THEN NULL
              ELSE ROUND(latest_cost.allocated_amount_cents::numeric*allocation.allocated_quantity/receipt.original_quantity)::bigint END AS cost_cents,
            COALESCE(receipt.intake_at,receipt.market_observed_at,receipt.recorded_at) AS held_since,
            ROUND({LOT_MARKET_VALUE_SQL}*100*allocation.allocated_quantity)::bigint AS intake_market_cents,
            ROUND((SELECT weekly.tcg_market_price FROM product_weekly_sales weekly
              WHERE weekly.sku_id=receipt.sku AND weekly.tcg_market_price IS NOT NULL
                AND weekly.week_start<=orders.order_time::date
                AND weekly.week_start>orders.order_time::date-{SALE_MARKET_LOOKBACK_DAYS}
              ORDER BY weekly.week_start DESC LIMIT 1)*100*allocation.allocated_quantity)::bigint AS sale_market_cents
          FROM inventory_fifo_lines fifo
          JOIN seller_orders orders ON orders.id=fifo.order_id
          JOIN seller_order_lines line ON line.order_id=fifo.order_id AND line.sku_id=fifo.order_line_sku_id
          JOIN inventory_fifo_revision_allocations allocation ON allocation.revision_id=fifo.current_revision_id
            AND allocation.disposition_id IS NULL AND allocation.quantity_correction_id IS NULL
          JOIN inventory_receipts receipt ON receipt.receipt_id=allocation.receipt_id
          LEFT JOIN product_lines product_line ON product_line.product_line_id=receipt.product_line_id
          LEFT JOIN latest_cost ON latest_cost.receipt_id=allocation.receipt_id
          WHERE fifo.seller_key=$1 AND fifo.state IN ('allocated','partial') AND orders.currency='USD'
          ORDER BY orders.order_time DESC"#
    );
    sqlx::query_as(&sql).bind(seller).fetch_all(&db.0).await
}

/// The seller's sold units, each at its share of its order's net proceeds.
pub async fn load(db: &Database, seller: &str) -> Result<Vec<SoldUnitLine>, String> {
    let seller = seller.trim();
    if seller.is_empty() {
        return Ok(Vec::new());
    }
    let (found, units) = tokio::join!(
        evidence::find(db, seller, evidence::FENCE),
        sold_units(db, seller)
    );
    let found = found.map_err(|e| e.to_string())?;
    let net_by_order: HashMap<String, Option<i64>> = calculate_orders(seller, &found)?
        .into_iter()
        .map(|o| (o.order_number, o.reusable_cash_cents))
        .collect();
    Ok(units
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|unit| {
            let order_net = net_by_order.get(&unit.order_number).copied().flatten();
            SoldUnitLine {
                net_proceeds_cents: order_net.filter(|_| unit.order_gross_cents > 0).map(|net| {
                    js_round(net as f64 * (unit.gross_cents as f64 / unit.order_gross_cents as f64))
                }),
                days_held: days_between(unit.held_since, unit.sold_at).max(0.0),
                order_number: unit.order_number,
                sold_at: unit.sold_at,
                product_line: unit.product_line,
                quantity: unit.quantity,
                gross_cents: unit.gross_cents,
                cost_cents: unit.cost_cents,
                intake_market_cents: unit.intake_market_cents,
                sale_market_cents: unit.sale_market_cents,
            }
        })
        .collect())
}
