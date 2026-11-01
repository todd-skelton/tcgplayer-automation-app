//! What each order's cards cost when they came into inventory and how long they were held, from
//! the seller's FIFO allocations (`enrichShippingOrdersWithIntakeHistory` over
//! `findShippingOrderAllocations`). A line's history is `current` only when the order as loaded
//! still matches the order history it was allocated from, and the allocation's totals match its
//! lots.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use sqlx::types::Json;

use super::orders::{IntakeHistory, IntakeLine, IntakeLot, Order};
use crate::database::Database;

/// The most orders read at once, as the Node route takes.
pub const MOST_ORDERS: usize = 500;

const DAY_MILLIS: f64 = 86_400_000.0;

/// A receipt lot an allocation took from.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Lot {
    supply_key: String,
    receipt_id: i64,
    quantity: i64,
    available_at: DateTime<Utc>,
    disposition_id: Option<String>,
    quantity_correction_id: Option<String>,
    receipt_kind: String,
    intake_at: Option<DateTime<Utc>>,
    market_value: Option<f64>,
    market_provenance: String,
}

impl Lot {
    /// The lot as a line shows it, for an allocation made at `allocated_at` (milliseconds).
    fn shown(&self, allocated_at: i64) -> IntakeLot {
        let source_kind = if self.disposition_id.is_some() {
            "physical_restock"
        } else if self.quantity_correction_id.is_some() {
            "quantity_correction"
        } else {
            &self.receipt_kind
        };
        let intake_at = self.intake_at.map(|at| at.timestamp_millis());
        IntakeLot {
            supply_key: self.supply_key.clone(),
            receipt_id: self.receipt_id,
            quantity: count(self.quantity),
            available_at: iso(self.available_at),
            source_kind: source_kind.to_owned(),
            intake_at: self.intake_at.map(iso),
            days_held: intake_at
                .filter(|at| *at <= allocated_at)
                .map(|at| (allocated_at - at) as f64 / DAY_MILLIS),
            intake_market_value: self.market_value,
            price_provenance: self.provenance().to_owned(),
        }
    }

    /// `priceProvenance`: a value worked out rather than paid is `estimated`.
    fn provenance(&self) -> &'static str {
        let worked_out = ["estimated", "modeled", "calculated"];
        let provenance = self.market_provenance.to_lowercase();
        match self.market_value {
            None => "unknown",
            Some(_) if worked_out.iter().any(|word| provenance.contains(word)) => "estimated",
            Some(_) => "recorded",
        }
    }
}

/// An order history line and the FIFO allocation of it, if any.
#[derive(sqlx::FromRow)]
struct Allocation {
    order_number: String,
    current_order_time: DateTime<Utc>,
    current_source_order_revision: i64,
    sku_id: String,
    current_ordered_quantity: i64,
    persisted_sold_total: f64,
    state: Option<String>,
    hold_reason: Option<String>,
    allocated_order_time: Option<DateTime<Utc>>,
    matched_quantity: Option<i64>,
    unmatched_quantity: Option<i64>,
    price_known_quantity: Option<i64>,
    date_known_quantity: Option<i64>,
    intake_market_total: Option<f64>,
    weighted_days_held: Option<f64>,
    revision_id: Option<String>,
    allocated_source_order_revision: Option<i64>,
    replay_status: Option<String>,
    queue_hold_reason: Option<String>,
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
        orders.source_revision::int8 AS current_source_order_revision,
        current_line.sku_id, current_line.ordered_quantity::int8 AS current_ordered_quantity,
        current_line.gross_item_proceeds::float8 AS persisted_sold_total, fifo.state, fifo.hold_reason,
        date_trunc('milliseconds', fifo.order_time) AS allocated_order_time,
        fifo.matched_quantity::int8 AS matched_quantity,
        fifo.unmatched_quantity::int8 AS unmatched_quantity,
        fifo.price_known_quantity::int8 AS price_known_quantity,
        fifo.date_known_quantity::int8 AS date_known_quantity,
        fifo.intake_market_total::float8 AS intake_market_total,
        fifo.weighted_days_held::float8 AS weighted_days_held,
        fifo.current_revision_id::text AS revision_id,
        fifo.source_order_revision::int8 AS allocated_source_order_revision,
        queue.status AS replay_status, queue.hold_reason AS queue_hold_reason,
        (fifo.id IS NULL OR queue.generation IS NOT NULL OR fifo.source_order_revision <> orders.source_revision) AS allocation_pending,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'supplyKey', allocation.supply_key, 'receiptId', allocation.receipt_id,
            'quantity', allocation.allocated_quantity, 'availableAt', allocation.available_at,
            'dispositionId', allocation.disposition_id::text,
            'quantityCorrectionId', allocation.quantity_correction_id::text,
            'receiptKind', receipt.receipt_kind, 'intakeAt', receipt.intake_at,
            'marketValue', receipt.market_value::float8, 'marketProvenance', receipt.market_provenance)
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

/// JavaScript's `toISOString`, to the millisecond.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// JavaScript's `Math.round(dollars * 100)`.
fn cents(dollars: f64) -> f64 {
    (dollars * 100.0 + 0.5).floor()
}

fn count(quantity: i64) -> u32 {
    u32::try_from(quantity.max(0)).unwrap_or(u32::MAX)
}

/// A line with no allocation to read (`unavailableLine`), dated as the order was loaded.
fn unavailable(sku_id: &str, order: &Order, quantity: i64) -> IntakeLine {
    IntakeLine {
        sku_id: sku_id.to_owned(),
        status: "unavailable".to_owned(),
        status_reason: Some("No exact persisted seller-order allocation is available.".to_owned()),
        order_time: order.order_date.clone(),
        ordered_quantity: count(quantity),
        unmatched_quantity: count(quantity),
        ..IntakeLine::default()
    }
}

/// What the order as loaded says of a line: when it was placed and what it sold for.
struct Shipped {
    placed_at: Option<i64>,
    sold_total: f64,
}

/// `historyStatus`: the line's status, and why when it is not `current`.
fn status(
    row: &Allocation,
    quantity: i64,
    shipped: Option<&Shipped>,
) -> (&'static str, Option<String>) {
    if row.current_ordered_quantity != quantity {
        let ordered = row.current_ordered_quantity;
        let why = format!("Shipping has {quantity} units; order history has {ordered}.");
        return ("mismatch", Some(why));
    }
    if let Some(shipped) = shipped
        && (shipped.placed_at != Some(row.current_order_time.timestamp_millis())
            || cents(shipped.sold_total) != cents(row.persisted_sold_total))
    {
        let why = "Shipping order time or SKU sale proceeds do not match current persisted order history.";
        return ("mismatch", Some(why.to_owned()));
    }
    if row.state.as_deref() == Some("held") || row.replay_status.as_deref() == Some("held") {
        let why = row.queue_hold_reason.as_ref().or(row.hold_reason.as_ref());
        let why = why.map_or("FIFO allocation needs review.", String::as_str);
        return ("held", Some(why.to_owned()));
    }
    if row.allocation_pending
        || row.revision_id.is_none()
        || matches!(row.replay_status.as_deref(), Some("pending" | "processing"))
    {
        return (
            "pending",
            Some("FIFO allocation is waiting to be refreshed.".to_owned()),
        );
    }
    if row.state.as_deref() == Some("unsupported") {
        let why = "This inventory identity is not a supported standard SKU.";
        return ("unavailable", Some(why.to_owned()));
    }
    ("current", None)
}

/// `currentLineHistory`: the allocation and its lots, `mismatch` when the lots do not add up to
/// its totals.
fn history(row: &Allocation, quantity: i64, shipped: Option<&Shipped>) -> IntakeLine {
    let allocated_at = row.allocated_order_time.unwrap_or(row.current_order_time);
    let lots: Vec<IntakeLot> = row
        .lots
        .0
        .iter()
        .map(|lot| lot.shown(allocated_at.timestamp_millis()))
        .collect();
    let units = |keep: fn(&IntakeLot) -> bool| -> i64 {
        lots.iter()
            .filter(|lot| keep(lot))
            .map(|lot| i64::from(lot.quantity))
            .sum()
    };
    let price_known = units(|lot| lot.intake_market_value.is_some());
    let date_known = units(|lot| lot.days_held.is_some());
    let market_total = (price_known != 0).then(|| {
        lots.iter()
            .filter_map(|lot| {
                lot.intake_market_value
                    .map(|value| value * f64::from(lot.quantity))
            })
            .fold(0.0, |total, value| total + value)
    });
    let days: Vec<f64> = lots.iter().filter_map(|lot| lot.days_held).collect();
    let totals_differ = units(|_| true) != row.matched_quantity.unwrap_or(0)
        || price_known != row.price_known_quantity.unwrap_or(0)
        || date_known != row.date_known_quantity.unwrap_or(0)
        || market_total.is_none() != row.intake_market_total.is_none()
        || market_total
            .is_some_and(|total| cents(total) != cents(row.intake_market_total.unwrap_or(0.0)));
    let (status, status_reason) = if totals_differ {
        let why = "Saved FIFO totals do not match their receipt allocation detail.";
        ("mismatch", Some(why.to_owned()))
    } else {
        status(row, quantity, shipped)
    };
    IntakeLine {
        sku_id: row.sku_id.clone(),
        status: status.to_owned(),
        status_reason,
        allocation_revision_id: row.revision_id.clone(),
        allocated_source_order_revision: row.allocated_source_order_revision,
        current_source_order_revision: row.current_source_order_revision,
        order_time: iso(allocated_at),
        ordered_quantity: count(quantity),
        sold_total: Some(row.persisted_sold_total),
        matched_quantity: count(row.matched_quantity.unwrap_or(0)),
        unmatched_quantity: count(row.unmatched_quantity.unwrap_or(quantity)),
        price_known_quantity: count(row.price_known_quantity.unwrap_or(0)),
        date_known_quantity: count(row.date_known_quantity.unwrap_or(0)),
        recorded_price_quantity: count(units(|lot| lot.price_provenance == "recorded")),
        estimated_price_quantity: count(units(|lot| lot.price_provenance == "estimated")),
        intake_market_total: row.intake_market_total,
        weighted_days_held: row.weighted_days_held,
        minimum_days_held: days.iter().copied().reduce(f64::min),
        maximum_days_held: days.iter().copied().reduce(f64::max),
        lots,
    }
}

/// Marks every line `mismatch`, for why.
fn mismatched(lines: &mut [IntakeLine], why: &str) {
    for line in lines {
        line.status = "mismatch".to_owned();
        line.status_reason = Some(why.to_owned());
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
                    None => unavailable(sku, order, *quantity),
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
            lines.push(unavailable("unidentified", order, unidentified));
        }
        if product_quantity > item_count {
            let why = format!(
                "Shipping product rows have {product_quantity} units; the order total has {item_count}."
            );
            mismatched(&mut lines, &why);
        }
    } else {
        let persisted_quantity: i64 = lines.iter().map(|l| i64::from(l.ordered_quantity)).sum();
        let persisted_sold: f64 = lines.iter().map(|l| l.sold_total.unwrap_or(0.0)).sum();
        if persisted_quantity < item_count {
            lines.push(unavailable(
                "unidentified",
                order,
                item_count - persisted_quantity,
            ));
        }
        if persisted_quantity > item_count
            || (persisted_quantity == item_count
                && cents(persisted_sold) != cents(order.value_of_products))
        {
            let why =
                "Persisted SKU quantities or sale proceeds do not match the shipping order total.";
            mismatched(&mut lines, why);
        }
    }
    if lines.is_empty() && item_count > 0 {
        lines.push(unavailable("unidentified", order, item_count));
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
