//! What each order's cards cost when they came into inventory and how long they were held, from
//! the seller's FIFO allocations (`enrichShippingOrdersWithIntakeHistory` over
//! `findShippingOrderAllocations`). A line's history is `current` only when the order as loaded
//! still matches the order history it was allocated from, and the allocation's totals match its
//! lots.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::types::Json;

use super::orders::{IntakeHistory, IntakeLine, Order};
use crate::database::Database;

/// The most orders read at once, as the Node route takes.
pub const MOST_ORDERS: usize = 500;

/// A receipt lot an allocation took from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lot {
    quantity: i64,
    intake_at: Option<DateTime<Utc>>,
    market_value: Option<f64>,
}

/// An order history line and the FIFO allocation of it, if any.
#[derive(sqlx::FromRow)]
struct Allocation {
    order_number: String,
    current_order_time: DateTime<Utc>,
    sku_id: String,
    current_ordered_quantity: i64,
    persisted_sold_total: f64,
    state: Option<String>,
    allocated_order_time: Option<DateTime<Utc>>,
    matched_quantity: Option<i64>,
    price_known_quantity: Option<i64>,
    date_known_quantity: Option<i64>,
    intake_market_total: Option<f64>,
    weighted_days_held: Option<f64>,
    revision_id: Option<String>,
    replay_status: Option<String>,
    allocation_pending: bool,
    lots: Json<Vec<Lot>>,
}

/// Times to the millisecond, as the Node app reads them.
async fn allocations(
    db: impl sqlx::PgExecutor<'_>,
    seller_key: &str,
    order_numbers: &[String],
) -> sqlx::Result<Vec<Allocation>> {
    sqlx::query_as(
        r#"WITH target_orders AS (
        SELECT orders.* FROM seller_orders orders
        WHERE orders.seller_key = $1 AND orders.order_number = ANY($2::text[])
      ) SELECT orders.order_number, date_trunc('milliseconds', orders.order_time) AS current_order_time,
        current_line.sku_id, current_line.ordered_quantity::int8 AS current_ordered_quantity,
        current_line.gross_item_proceeds::float8 AS persisted_sold_total, fifo.state,
        date_trunc('milliseconds', fifo.order_time) AS allocated_order_time,
        fifo.matched_quantity::int8 AS matched_quantity,
        fifo.price_known_quantity::int8 AS price_known_quantity,
        fifo.date_known_quantity::int8 AS date_known_quantity,
        fifo.intake_market_total::float8 AS intake_market_total,
        fifo.weighted_days_held::float8 AS weighted_days_held,
        fifo.current_revision_id::text AS revision_id, queue.status AS replay_status,
        (fifo.id IS NULL OR queue.generation IS NOT NULL OR fifo.source_order_revision <> orders.source_revision) AS allocation_pending,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('quantity', allocation.allocated_quantity,
            'intakeAt', receipt.intake_at, 'marketValue', receipt.market_value::float8)
          ORDER BY allocation.available_at, allocation.supply_key)
          FROM inventory_fifo_revision_allocations allocation
          JOIN inventory_receipts receipt ON receipt.receipt_id = allocation.receipt_id
          WHERE allocation.revision_id = fifo.current_revision_id), '[]'::jsonb) AS lots
      FROM target_orders orders JOIN seller_order_lines current_line ON current_line.order_id = orders.id
      LEFT JOIN inventory_fifo_lines fifo ON fifo.order_id = orders.id AND fifo.order_line_sku_id = current_line.sku_id
      LEFT JOIN inventory_fifo_replay_queue queue ON queue.seller_key = orders.seller_key AND queue.sku = fifo.sku
      ORDER BY orders.order_number, current_line.sku_id"#,
    )
    .bind(seller_key)
    .bind(order_numbers)
    .fetch_all(db)
    .await
}

/// JavaScript's `Math.round(dollars * 100)`.
fn cents(dollars: f64) -> f64 {
    (dollars * 100.0 + 0.5).floor()
}

fn count(quantity: i64) -> u32 {
    u32::try_from(quantity.max(0)).unwrap_or(u32::MAX)
}

/// A line with no allocation to read.
fn unavailable(sku_id: &str, quantity: i64) -> IntakeLine {
    IntakeLine {
        sku_id: sku_id.to_owned(),
        status: "unavailable".to_owned(),
        sold_total: None,
        ordered_quantity: count(quantity),
        price_known_quantity: 0,
        date_known_quantity: 0,
        intake_market_total: None,
        weighted_days_held: None,
    }
}

/// What the order as loaded says of a line: when it was placed and what it sold for.
struct Shipped {
    placed_at: Option<i64>,
    sold_total: f64,
}

/// `historyStatus`.
fn status(row: &Allocation, quantity: i64, shipped: Option<&Shipped>) -> &'static str {
    if row.current_ordered_quantity != quantity {
        return "mismatch";
    }
    if let Some(shipped) = shipped
        && (shipped.placed_at != Some(row.current_order_time.timestamp_millis())
            || cents(shipped.sold_total) != cents(row.persisted_sold_total))
    {
        return "mismatch";
    }
    if row.state.as_deref() == Some("held") || row.replay_status.as_deref() == Some("held") {
        return "held";
    }
    if row.allocation_pending
        || row.revision_id.is_none()
        || matches!(row.replay_status.as_deref(), Some("pending" | "processing"))
    {
        return "pending";
    }
    if row.state.as_deref() == Some("unsupported") {
        return "unavailable";
    }
    "current"
}

/// `currentLineHistory`: the allocation's totals, `mismatch` when its lots do not add up to them.
fn history(row: &Allocation, quantity: i64, shipped: Option<&Shipped>) -> IntakeLine {
    let allocated_at = row.allocated_order_time.unwrap_or(row.current_order_time);
    let lots = &row.lots.0;
    let dated = |lot: &&Lot| lot.intake_at.is_some_and(|at| at <= allocated_at);
    let matched: i64 = lots.iter().map(|lot| lot.quantity).sum();
    let price_known: i64 = lots
        .iter()
        .filter(|lot| lot.market_value.is_some())
        .map(|lot| lot.quantity)
        .sum();
    let date_known: i64 = lots.iter().filter(dated).map(|lot| lot.quantity).sum();
    let market_total = (price_known != 0).then(|| {
        lots.iter()
            .filter_map(|lot| lot.market_value.map(|value| value * lot.quantity as f64))
            .sum::<f64>()
    });
    let totals_differ = matched != row.matched_quantity.unwrap_or(0)
        || price_known != row.price_known_quantity.unwrap_or(0)
        || date_known != row.date_known_quantity.unwrap_or(0)
        || market_total.is_none() != row.intake_market_total.is_none()
        || market_total
            .is_some_and(|total| cents(total) != cents(row.intake_market_total.unwrap_or(0.0)));
    IntakeLine {
        sku_id: row.sku_id.clone(),
        status: if totals_differ {
            "mismatch"
        } else {
            status(row, quantity, shipped)
        }
        .to_owned(),
        sold_total: Some(row.persisted_sold_total),
        ordered_quantity: count(quantity),
        price_known_quantity: count(row.price_known_quantity.unwrap_or(0)),
        date_known_quantity: count(row.date_known_quantity.unwrap_or(0)),
        intake_market_total: row.intake_market_total,
        weighted_days_held: row.weighted_days_held,
    }
}

/// One order's history from its allocations, by SKU in the order the order history keeps them.
fn order_history(order: &Order, allocated: &[&Allocation]) -> Vec<IntakeLine> {
    let item_count = i64::from(order.item_count);
    let products = order.lines();
    let mut grouped: Vec<(String, i64, f64)> = Vec::new();
    for line in products {
        let Some(sku) = line.inventory_sku() else {
            continue;
        };
        let quantity = i64::from(line.quantity);
        match grouped.iter_mut().find(|(id, ..)| *id == sku) {
            Some((_, total, sold)) => {
                *total += quantity;
                *sold += line.unit_price * line.quantity as f64;
            }
            None => grouped.push((sku, quantity, line.unit_price * line.quantity as f64)),
        }
    }
    let placed_at = order.placed_at();
    let mut lines: Vec<IntakeLine> = if grouped.is_empty() {
        allocated
            .iter()
            .map(|row| history(row, row.current_ordered_quantity, None))
            .collect()
    } else {
        grouped
            .iter()
            .map(|(sku, quantity, sold_total)| {
                match allocated.iter().find(|row| row.sku_id == *sku) {
                    Some(row) => history(
                        row,
                        *quantity,
                        Some(&Shipped {
                            placed_at,
                            sold_total: *sold_total,
                        }),
                    ),
                    None => unavailable(sku, *quantity),
                }
            })
            .collect()
    };
    let product_quantity: i64 = products.iter().map(|l| i64::from(l.quantity)).sum();
    if !products.is_empty() {
        let unidentified: i64 = products
            .iter()
            .filter(|l| l.inventory_sku().is_none())
            .map(|l| i64::from(l.quantity))
            .sum::<i64>()
            + (item_count - product_quantity).max(0);
        if unidentified != 0 {
            lines.push(unavailable("unidentified", unidentified));
        }
        if product_quantity > item_count {
            for line in &mut lines {
                line.status = "mismatch".to_owned();
            }
        }
    } else {
        let persisted_quantity: i64 = lines.iter().map(|l| i64::from(l.ordered_quantity)).sum();
        let persisted_sold: f64 = lines.iter().map(|l| l.sold_total.unwrap_or(0.0)).sum();
        if persisted_quantity < item_count {
            lines.push(unavailable("unidentified", item_count - persisted_quantity));
        }
        if persisted_quantity > item_count
            || (persisted_quantity == item_count
                && cents(persisted_sold) != cents(order.value_of_products))
        {
            for line in &mut lines {
                line.status = "mismatch".to_owned();
            }
        }
    }
    if lines.is_empty() && item_count > 0 {
        lines.push(unavailable("unidentified", item_count));
    }
    lines
}

/// Gives each order its intake history for `seller_key`, the configured seller.
pub async fn attach(db: &Database, seller_key: &str, orders: &mut [Order]) -> Result<(), String> {
    let seller_key = seller_key.trim();
    let mut numbers: Vec<String> = Vec::new();
    for order in orders.iter() {
        let number = order.number.trim();
        if !number.is_empty() && !numbers.iter().any(|n| n == number) {
            numbers.push(number.to_owned());
        }
    }
    if numbers.len() > MOST_ORDERS {
        return Err(format!(
            "Intake history is limited to {MOST_ORDERS} orders per request."
        ));
    }
    let rows = if numbers.is_empty() {
        Vec::new()
    } else {
        allocations(&db.0, seller_key, &numbers)
            .await
            .map_err(|e| e.to_string())?
    };
    let refreshed_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    for order in orders.iter_mut() {
        let allocated: Vec<&Allocation> = rows
            .iter()
            .filter(|row| row.order_number == order.number)
            .collect();
        order.intake_history = Some(IntakeHistory {
            order_number: order.number.clone(),
            seller_key: seller_key.to_owned(),
            lines: order_history(order, &allocated),
            refreshed_at: refreshed_at.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// The orders `.port-logs/intake-history-node.ts` built from the dev seller's order history,
    /// with the replays `intake-history-seed.sql` queues, in a transaction rolled back: each line's
    /// status and totals are Node's.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's histories in .port-logs"]
    async fn histories_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/intake-history.node.json").unwrap(),
        )
        .unwrap();
        let seed = std::fs::read_to_string(".port-logs/intake-history-seed.sql").unwrap();
        let seller = node["seller"].as_str().unwrap();
        let mut orders: Vec<Order> = serde_json::from_value(node["orders"].clone()).unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&seed).execute(&mut *tx).await.unwrap();
        let numbers: Vec<String> = orders.iter().map(|o| o.number.clone()).collect();
        let rows = allocations(&mut *tx, seller, &numbers).await.unwrap();
        tx.rollback().await.unwrap();
        for (order, theirs) in orders.iter_mut().zip(node["histories"].as_array().unwrap()) {
            let allocated: Vec<&Allocation> = rows
                .iter()
                .filter(|r| r.order_number == order.number)
                .collect();
            let ours = order_history(order, &allocated);
            let theirs: Vec<IntakeLine> = serde_json::from_value(theirs["lines"].clone()).unwrap();
            assert_eq!(ours, theirs, "order {}", order.number);
        }
    }
}
