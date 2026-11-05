//! One seller SKU's replay, ported from `inventoryFifoRepository.processNextReplay`: the checks
//! that hold a SKU for a person to reconcile, then every sold line matched again from the start of
//! the SKU's history, each with the fingerprint Node saves to tell a changed line from the same one.
//!
//! [`load`] reads what Node reads, in a read-only transaction; [`plan`] is the rest, kept pure.
use std::collections::{BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

use super::allocate::{self, Allocation, LineResult, OrderLine, SupplyLot};
use crate::features::inventory_economics::ledger::assumptions::js_to_fixed;

const SUPPORTED_LIFECYCLES: [&str; 5] = [
    "processing",
    "ready_to_ship",
    "shipped_in_transit",
    "shipped_delivered",
    "completed_paid",
];

/// A sold line as Node saves it, a revision of `inventory_fifo_lines`.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedLine {
    pub order_id: String,
    pub sku_id: String,
    pub order_time: DateTime<Utc>,
    pub ordered_quantity: i64,
    pub source_order_revision: i32,
    pub state: &'static str,
    pub hold_reason: Option<String>,
    pub matched_quantity: i64,
    pub unmatched_quantity: i64,
    pub price_known_quantity: i64,
    pub date_known_quantity: i64,
    pub intake_market_total: Option<String>,
    pub weighted_days_held: Option<String>,
    pub allocations: Vec<Allocation>,
}

/// JavaScript's `Date.prototype.toISOString`.
pub fn iso(time: DateTime<Utc>) -> String {
    time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// An allocation as the fingerprint lists it: supply, receipt, disposition, correction, quantity, available.
type FingerprintedAllocation<'a> = (&'a str, i64, Option<&'a str>, Option<&'a str>, i64, String);

/// `lineFingerprint`: sha256 of JSON.stringify over the saved fields, in Node's key order.
pub fn fingerprint(line: &SavedLine) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Fingerprinted<'a> {
        source_order_revision: i32,
        order_time: String,
        ordered_quantity: i64,
        state: &'a str,
        hold_reason: Option<&'a str>,
        matched_quantity: i64,
        unmatched_quantity: i64,
        price_known_quantity: i64,
        date_known_quantity: i64,
        intake_market_total: Option<&'a str>,
        weighted_days_held: Option<&'a str>,
        allocations: Vec<FingerprintedAllocation<'a>>,
    }
    let json = serde_json::to_string(&Fingerprinted {
        source_order_revision: line.source_order_revision,
        order_time: iso(line.order_time),
        ordered_quantity: line.ordered_quantity,
        state: line.state,
        hold_reason: line.hold_reason.as_deref(),
        matched_quantity: line.matched_quantity,
        unmatched_quantity: line.unmatched_quantity,
        price_known_quantity: line.price_known_quantity,
        date_known_quantity: line.date_known_quantity,
        intake_market_total: line.intake_market_total.as_deref(),
        weighted_days_held: line.weighted_days_held.as_deref(),
        allocations: line
            .allocations
            .iter()
            .map(|a| {
                (
                    a.supply_key.as_str(),
                    a.receipt_id,
                    a.disposition_id.as_deref(),
                    a.quantity_correction_id.as_deref(),
                    a.quantity,
                    iso(a.available_at),
                )
            })
            .collect(),
    })
    .expect("the fingerprint fields serialize");
    format!("{:x}", Sha256::digest(json.as_bytes()))
}

/// An order line the SKU was sold on, or a saved line whose order no longer has it (quantity 0).
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Demand {
    #[sqlx(rename = "orderId")]
    pub order_id: String,
    #[sqlx(rename = "orderNumber")]
    pub order_number: String,
    #[sqlx(rename = "orderTime")]
    pub order_time: DateTime<Utc>,
    pub lifecycle: String,
    #[sqlx(rename = "sourceRevision")]
    pub source_revision: i32,
    #[sqlx(rename = "skuId")]
    pub sku_id: String,
    pub quantity: i32,
}

impl Demand {
    fn key(&self) -> String {
        format!("{}:{}", self.order_id, self.sku_id)
    }
}

/// A saved line whose order's quantity changed since it was matched.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct QuantityChange {
    #[sqlx(rename = "lineId")]
    pub line_id: String,
    #[sqlx(rename = "orderId")]
    pub order_id: String,
    #[sqlx(rename = "skuId")]
    pub sku_id: String,
    pub direction: String,
    #[sqlx(rename = "needsInitialProjection")]
    pub needs_initial_projection: bool,
    #[sqlx(rename = "previousQuantity")]
    pub previous_quantity: i32,
    #[sqlx(rename = "previousOrderTime")]
    pub previous_order_time: DateTime<Utc>,
    #[sqlx(rename = "previousSourceRevision")]
    pub previous_source_revision: i32,
}

/// Stock put back from a sold line: a disposition (restock or cancellation) or a quantity
/// correction, one row per receipt it returns to.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Restock {
    pub id: String,
    #[sqlx(rename = "orderId")]
    pub order_id: String,
    #[sqlx(rename = "skuId")]
    pub sku_id: String,
    /// The disposition type; none for a quantity correction.
    #[sqlx(rename = "type")]
    pub kind: Option<String>,
    #[sqlx(rename = "receiptId")]
    pub receipt_id: i32,
    #[sqlx(rename = "sourceSupplyKey")]
    pub source_supply_key: String,
    pub quantity: i32,
    #[sqlx(rename = "restockSupplyKey")]
    pub restock_supply_key: String,
    pub corrected: bool,
}

/// A row of the SKU's stock, its quantity net of corrected restocks.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Supply {
    #[sqlx(rename = "supplyKey")]
    pub supply_key: String,
    #[sqlx(rename = "receiptId")]
    pub receipt_id: i32,
    #[sqlx(rename = "dispositionId")]
    pub disposition_id: Option<String>,
    #[sqlx(rename = "quantityCorrectionId")]
    pub quantity_correction_id: Option<String>,
    pub quantity: i32,
    #[sqlx(rename = "availableAt")]
    pub available_at: DateTime<Utc>,
    #[sqlx(rename = "fifoPrecedence")]
    pub fifo_precedence: i16,
    #[sqlx(rename = "intakeAt")]
    pub intake_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "marketValue")]
    pub market_value: Option<String>,
}

/// Everything the replay matches from, once the SQL holds have passed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Inputs {
    pub history_from: DateTime<Utc>,
    pub demand: Vec<Demand>,
    pub quantity_changes: Vec<QuantityChange>,
    pub dispositions: Vec<Restock>,
    pub quantity_corrections: Vec<Restock>,
    pub supplies: Vec<Supply>,
    pub shipped_orders: HashSet<String>,
}

/// What replaying a SKU does.
#[derive(Clone, Debug, PartialEq)]
pub enum Replay {
    /// Held before any line is saved.
    Held(String),
    /// The lines saved, and the hold the SKU is left in after, if any.
    Saved {
        lines: Vec<SavedLine>,
        held: Option<String>,
    },
}

/// Node's `Math.round(Number(text) * 10_000)` for a nonnegative market value.
fn ten_thousandths(text: &str) -> Option<i64> {
    text.parse::<f64>()
        .ok()
        .map(|value| (value * 10_000.0).round() as i64)
}

pub fn plan(inputs: &Inputs) -> Result<Replay, allocate::Refused> {
    let history_from = inputs.history_from;
    if let Some(blocking) = inputs
        .quantity_changes
        .iter()
        .find(|change| change.direction != "decrease" || !change.needs_initial_projection)
    {
        return Ok(Replay::Held(format!(
            "order_quantity_{}_requires_correction:{}",
            blocking.direction, blocking.line_id
        )));
    }
    let initial_decreases: HashMap<String, &QuantityChange> = inputs
        .quantity_changes
        .iter()
        .map(|change| (format!("{}:{}", change.order_id, change.sku_id), change))
        .collect();
    let demand: Vec<Demand> = inputs
        .demand
        .iter()
        .map(|row| match initial_decreases.get(&row.key()) {
            Some(change) => Demand {
                quantity: change.previous_quantity,
                order_time: change.previous_order_time,
                source_revision: change.previous_source_revision,
                ..row.clone()
            },
            None => row.clone(),
        })
        .collect();

    let edges: HashMap<&str, &Restock> = inputs
        .dispositions
        .iter()
        .chain(&inputs.quantity_corrections)
        .map(|row| (row.restock_supply_key.as_str(), row))
        .collect();
    let excluded_origins = |supply_key: &str| {
        let mut origins = BTreeSet::new();
        let mut visited = HashSet::new();
        let mut current = supply_key;
        while visited.insert(current) {
            let Some(edge) = edges.get(current) else {
                break;
            };
            origins.insert(format!("{}:{}", edge.order_id, edge.sku_id));
            current = &edge.source_supply_key;
        }
        origins.into_iter().collect::<Vec<_>>()
    };
    let supplies: Vec<SupplyLot> = inputs
        .supplies
        .iter()
        .filter(|row| row.quantity > 0)
        .map(|row| SupplyLot {
            supply_key: row.supply_key.clone(),
            receipt_id: row.receipt_id.into(),
            disposition_id: row.disposition_id.clone(),
            quantity_correction_id: row.quantity_correction_id.clone(),
            excluded_line_keys: excluded_origins(&row.supply_key),
            quantity: row.quantity.into(),
            available_at: row.available_at,
            fifo_precedence: u8::try_from(row.fifo_precedence).unwrap_or(1),
            intake_at: row.intake_at,
            market_value_ten_thousandths: row.market_value.as_deref().and_then(ten_thousandths),
        })
        .collect();

    let mut dispositions_by_line: HashMap<String, Vec<&Restock>> = HashMap::new();
    for disposition in &inputs.dispositions {
        dispositions_by_line
            .entry(format!("{}:{}", disposition.order_id, disposition.sku_id))
            .or_default()
            .push(disposition);
    }
    let shipped = |row: &Demand| inputs.shipped_orders.contains(&row.order_id);
    // A canceled order that never shipped never took stock; one that shipped is a return that
    // comes back as new intake. A recorded disposition decides over either.
    let unfulfilled_cancellation = |row: &Demand| {
        row.lifecycle == "canceled"
            && !shipped(row)
            && !dispositions_by_line.contains_key(&row.key())
    };
    let allocatable: Vec<OrderLine> = demand
        .iter()
        .filter(|row| {
            row.quantity > 0 && row.order_time >= history_from && !unfulfilled_cancellation(row)
        })
        .map(|row| OrderLine {
            line_key: row.key(),
            order_id: row.order_id.clone(),
            order_number: row.order_number.clone(),
            order_time: row.order_time,
            quantity: row.quantity.into(),
        })
        .collect();
    let results: HashMap<String, LineResult> = allocate::allocate(&allocatable, &supplies)?
        .into_iter()
        .map(|result| (result.line_key.clone(), result))
        .collect();

    for disposition in inputs.dispositions.iter().filter(|d| !d.corrected) {
        let allocated: i64 = results
            .get(&format!("{}:{}", disposition.order_id, disposition.sku_id))
            .map(|result| {
                result
                    .allocations
                    .iter()
                    .filter(|a| {
                        a.supply_key == disposition.source_supply_key
                            && a.receipt_id == i64::from(disposition.receipt_id)
                    })
                    .map(|a| a.quantity)
                    .sum()
            })
            .unwrap_or(0);
        let disposed: i64 = inputs
            .dispositions
            .iter()
            .filter(|row| {
                row.order_id == disposition.order_id
                    && row.sku_id == disposition.sku_id
                    && row.source_supply_key == disposition.source_supply_key
            })
            .map(|row| i64::from(row.quantity))
            .sum();
        if disposed > allocated {
            return Ok(Replay::Held(format!(
                "restock_lineage_conflict:{}",
                disposition.id
            )));
        }
    }

    let lines = demand
        .iter()
        .map(|row| {
            let key = row.key();
            let quantity = i64::from(row.quantity);
            let unallocated = LineResult {
                line_key: key.clone(),
                allocations: Vec::new(),
                requested_quantity: quantity,
                matched_quantity: 0,
                unmatched_quantity: quantity,
                price_known_quantity: 0,
                intake_market_total_cents: None,
                date_known_quantity: 0,
                weighted_days_held: None,
            };
            let mut result = results
                .get(&key)
                .cloned()
                .unwrap_or_else(|| unallocated.clone());
            let mut state = if result.matched_quantity == quantity {
                "allocated"
            } else if result.matched_quantity > 0 {
                "partial"
            } else {
                "unmatched"
            };
            let mut hold_reason = None;
            if quantity == 0 {
                state = "removed";
                result.unmatched_quantity = 0;
            } else if row.order_time < history_from {
                state = "excluded_pre_cutoff";
                result = LineResult {
                    line_key: result.line_key,
                    requested_quantity: result.requested_quantity,
                    ..unallocated
                };
            } else if unfulfilled_cancellation(row) {
                state = "canceled_unfulfilled";
                result = LineResult {
                    line_key: result.line_key,
                    requested_quantity: result.requested_quantity,
                    ..unallocated
                };
            } else if let (true, Some(restocks)) =
                (row.lifecycle == "canceled", dispositions_by_line.get(&key))
            {
                let restored: i64 = restocks.iter().map(|r| i64::from(r.quantity)).sum();
                let proven = restored >= quantity
                    && restocks.iter().all(|r| match r.kind.as_deref() {
                        Some("physical_restock") => true,
                        Some("unfulfilled_cancellation") => !shipped(row),
                        _ => false,
                    });
                if !proven {
                    state = "held";
                    hold_reason = Some(
                        if shipped(row) {
                            "canceled_after_shipping_requires_restock"
                        } else {
                            "cancellation_requires_disposition"
                        }
                        .to_owned(),
                    );
                }
            } else if row.lifecycle != "canceled"
                && !SUPPORTED_LIFECYCLES.contains(&row.lifecycle.as_str())
            {
                state = "held";
                hold_reason = Some("unknown_order_lifecycle".to_owned());
            }
            if let Some(decrease) = initial_decreases.get(&key) {
                state = "held";
                hold_reason = Some(format!(
                    "order_quantity_decrease_requires_correction:{}",
                    decrease.line_id
                ));
            }
            SavedLine {
                order_id: row.order_id.clone(),
                sku_id: row.sku_id.clone(),
                order_time: row.order_time,
                ordered_quantity: quantity,
                source_order_revision: row.source_revision,
                state,
                hold_reason,
                matched_quantity: result.matched_quantity,
                unmatched_quantity: result.unmatched_quantity,
                price_known_quantity: result.price_known_quantity,
                date_known_quantity: result.date_known_quantity,
                intake_market_total: result
                    .intake_market_total_cents
                    .map(|cents| js_to_fixed(cents as f64 / 100.0, 2)),
                weighted_days_held: result.weighted_days_held.map(|days| js_to_fixed(days, 6)),
                allocations: result.allocations,
            }
        })
        .collect();
    let held = inputs.quantity_changes.first().map(|change| {
        format!(
            "order_quantity_decrease_requires_correction:{}",
            change.line_id
        )
    });
    Ok(Replay::Saved { lines, held })
}

/// A SQL check's first row id, which holds the SKU under `reason:id`.
async fn first(
    conn: &mut PgConnection,
    sql: &str,
    seller: &str,
    sku: i32,
    from: Option<DateTime<Utc>>,
) -> sqlx::Result<Option<String>> {
    let query = sqlx::query_scalar::<_, Option<String>>(sql)
        .bind(seller)
        .bind(sku);
    let query = match from {
        Some(from) => query.bind(from),
        None => query,
    };
    Ok(query.fetch_optional(&mut *conn).await?.flatten())
}

/// Reads one SKU's replay inputs as Node does, or the hold Node's checks put it in. Run it in a
/// read-only transaction: it never claims the queue or takes Node's advisory lock.
pub async fn load(
    conn: &mut PgConnection,
    seller: &str,
    sku: i32,
) -> sqlx::Result<Result<Inputs, String>> {
    let opening: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT cutoff_at FROM inventory_opening_balance_runs WHERE seller_key=$1 AND status='applied'",
    )
    .bind(seller)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(opening) = opening else {
        return Ok(Err("missing_applied_opening_balance".into()));
    };
    // Backfilled listing history moves this SKU's start back to its first covered publication.
    let covered_from: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT covered_from FROM inventory_listing_history_coverage WHERE seller_key=$1 AND sku=$2",
    )
    .bind(seller)
    .bind(sku)
    .fetch_optional(&mut *conn)
    .await?;
    let history_from = covered_from.unwrap_or(opening);

    let checks_from_history: [(&str, &str); 1] = [(
        "order_time_change_requires_reconciliation",
        r#"SELECT saved.id::text FROM inventory_fifo_lines saved JOIN seller_orders orders ON orders.id=saved.order_id
          WHERE saved.seller_key=$1 AND saved.sku=$2 AND saved.order_time IS DISTINCT FROM orders.order_time
            AND (saved.order_time>=$3 OR orders.order_time>=$3) LIMIT 1"#,
    )];
    for (reason, sql) in checks_from_history {
        if let Some(id) = first(conn, sql, seller, sku, Some(history_from)).await? {
            return Ok(Err(format!("{reason}:{id}")));
        }
    }
    if let Some(id) = first(
        conn,
        r#"SELECT orders.id::text FROM seller_orders orders JOIN seller_order_revisions revision
            ON revision.order_id=orders.id AND revision.revision_number=1
          CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) evidence
          WHERE orders.seller_key=$1 AND revision.order_time IS NULL AND evidence->>'skuId'=$2::text LIMIT 1"#,
        seller,
        sku,
        None,
    )
    .await?
    {
        return Ok(Err(format!("historical_order_time_unknown:{id}")));
    }
    let differences: Vec<(String, i32, i32)> = sqlx::query_as(
        r#"SELECT difference.id::text, difference.quantity_delta,
        (
          COALESCE((SELECT SUM(link.planned_quantity)::int
            FROM inventory_publication_receipt_links link
            JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
            WHERE link.target_seller_key=difference.seller_key AND receipt.sku=difference.sku
              AND receipt.receipt_kind='received' AND link.live_at>=previous.cutoff_at
              AND link.live_at<observation.cutoff_at),0)
          + COALESCE((SELECT SUM(disposition.quantity)::int FROM inventory_stock_dispositions disposition
            WHERE disposition.seller_key=difference.seller_key AND disposition.sku=difference.sku
              AND disposition.available_at>=previous.cutoff_at AND disposition.available_at<observation.cutoff_at),0)
          - COALESCE((SELECT SUM((evidence->>'quantity')::int)::int
            FROM seller_orders orders JOIN seller_order_revisions revision
              ON revision.order_id=orders.id AND revision.revision_number=1
            CROSS JOIN LATERAL jsonb_array_elements(revision.line_evidence) evidence
            WHERE orders.seller_key=difference.seller_key
              AND revision.order_time>=previous.cutoff_at AND revision.order_time<observation.cutoff_at
              AND evidence->>'skuId'=difference.sku::text),0)
          + COALESCE((SELECT SUM(correction.released_quantity)::int
            FROM inventory_order_quantity_corrections correction
            WHERE correction.seller_key=difference.seller_key AND correction.sku=difference.sku
              AND correction.available_at>=previous.cutoff_at AND correction.available_at<observation.cutoff_at),0)
        )::int
        FROM inventory_observation_differences difference
        JOIN inventory_complete_observations observation ON observation.id=difference.observation_id
        JOIN inventory_complete_observations previous ON previous.id=difference.previous_observation_id
        WHERE difference.seller_key=$1 AND difference.sku=$2 AND observation.cutoff_at>$3
        ORDER BY observation.cutoff_at,difference.id"#,
    )
    .bind(seller)
    .bind(sku)
    .bind(opening)
    .fetch_all(&mut *conn)
    .await?;
    if let Some((id, observed, expected)) = differences
        .into_iter()
        .find(|(_, observed, expected)| observed != expected)
    {
        return Ok(Err(format!(
            "unexplained_inventory_difference:{id}:observed_{observed}:expected_{expected}"
        )));
    }
    let checks: [(&str, &str); 5] = [
        (
            "quantity_reduction_after_restock",
            r#"SELECT line.id::text FROM inventory_fifo_lines line
            LEFT JOIN seller_order_lines current_line ON current_line.order_id=line.order_id
              AND current_line.sku_id=line.order_line_sku_id
            WHERE line.seller_key=$1 AND line.sku=$2
              AND COALESCE(current_line.ordered_quantity,0)<line.ordered_quantity
              AND EXISTS (
                SELECT 1 FROM inventory_stock_dispositions disposition
                WHERE disposition.order_id=line.order_id AND disposition.order_line_sku_id=line.order_line_sku_id
                  AND NOT EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
                    WHERE correction.disposition_id=disposition.id)
              ) LIMIT 1"#,
        ),
        (
            "return_correction_invalidated",
            r#"SELECT MIN(correction.id)::text FROM inventory_stock_dispositions disposition
            JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
            LEFT JOIN seller_order_lines current_line ON current_line.order_id=disposition.order_id
              AND current_line.sku_id=disposition.order_line_sku_id
            WHERE disposition.seller_key=$1 AND disposition.sku=$2
            GROUP BY disposition.order_id,disposition.order_line_sku_id,current_line.ordered_quantity
            HAVING MAX(disposition.source_ordered_quantity)-COALESCE(current_line.ordered_quantity,0)<SUM(disposition.quantity)
            LIMIT 1"#,
        ),
        (
            "unfulfilled_cancellation_invalidated",
            r#"SELECT disposition.id::text FROM inventory_stock_dispositions disposition
            JOIN seller_orders orders ON orders.id=disposition.order_id
            WHERE disposition.seller_key=$1 AND disposition.sku=$2 AND disposition.disposition_type='unfulfilled_cancellation'
              AND orders.lifecycle<>'canceled' LIMIT 1"#,
        ),
        (
            "stock_disposition_chronology_invalidated",
            r#"SELECT disposition.id::text FROM inventory_stock_dispositions disposition
            JOIN seller_orders orders ON orders.id=disposition.order_id
            WHERE disposition.seller_key=$1 AND disposition.sku=$2 AND orders.order_time>disposition.available_at LIMIT 1"#,
        ),
        (
            "order_quantity_correction_invalidated",
            r#"SELECT correction.id::text FROM inventory_order_quantity_corrections correction
            JOIN seller_orders orders ON orders.id=correction.order_id
            LEFT JOIN seller_order_lines line ON line.order_id=orders.id AND line.sku_id=correction.order_line_sku_id
            WHERE correction.seller_key=$1 AND correction.sku=$2 AND orders.source_revision>correction.source_order_revision
              AND (COALESCE(line.ordered_quantity,0)>correction.corrected_quantity
                OR orders.order_time>correction.available_at) LIMIT 1"#,
        ),
    ];
    for (reason, sql) in checks {
        if let Some(id) = first(conn, sql, seller, sku, None).await? {
            return Ok(Err(format!("{reason}:{id}")));
        }
    }

    let mut demand: Vec<Demand> = sqlx::query_as(
        r#"SELECT orders.id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.sku_id AS "skuId",line.ordered_quantity AS quantity
        FROM seller_orders orders JOIN seller_order_lines line ON line.order_id=orders.id
        WHERE orders.seller_key=$1 AND line.sku_id=$2::text"#,
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    let removed: Vec<Demand> = sqlx::query_as(
        r#"SELECT line.order_id::text AS "orderId",orders.order_number AS "orderNumber",
        orders.order_time AS "orderTime",orders.lifecycle,orders.source_revision AS "sourceRevision",
        line.order_line_sku_id AS "skuId",0::int AS quantity
        FROM inventory_fifo_lines line JOIN seller_orders orders ON orders.id=line.order_id
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=line.order_id
          AND current_line.sku_id=line.order_line_sku_id
        WHERE line.seller_key=$1 AND line.sku=$2 AND current_line.order_id IS NULL"#,
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    demand.extend(removed);
    if let Some(id) = first(
        conn,
        r#"SELECT saved.id::text FROM inventory_fifo_lines saved JOIN seller_orders orders ON orders.id=saved.order_id
        JOIN seller_order_revisions initial ON initial.order_id=orders.id AND initial.revision_number=1
        WHERE saved.seller_key=$1 AND saved.sku=$2 AND saved.current_revision_id IS NULL
          AND orders.order_time>=$3 AND orders.source_revision>1
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(initial.line_evidence) evidence
            WHERE evidence->>'skuId'=saved.order_line_sku_id) LIMIT 1"#,
        seller,
        sku,
        Some(history_from),
    )
    .await?
    {
        return Ok(Err(format!("order_line_addition_requires_correction:{id}")));
    }
    let quantity_changes: Vec<QuantityChange> = sqlx::query_as(
        r#"SELECT saved.id::text AS "lineId",
          saved.order_id::text AS "orderId",saved.order_line_sku_id AS "skuId",
          CASE WHEN COALESCE(current_line.ordered_quantity,0)>saved.ordered_quantity THEN 'increase' ELSE 'decrease' END AS direction,
          saved.current_revision_id IS NULL AS "needsInitialProjection",saved.ordered_quantity AS "previousQuantity",
          saved.order_time AS "previousOrderTime",saved.source_order_revision AS "previousSourceRevision"
        FROM inventory_fifo_lines saved
        LEFT JOIN seller_order_lines current_line ON current_line.order_id=saved.order_id
          AND current_line.sku_id=saved.order_line_sku_id
        JOIN seller_orders orders ON orders.id=saved.order_id
        WHERE saved.seller_key=$1 AND saved.sku=$2
          AND orders.order_time>=$3
          AND COALESCE(current_line.ordered_quantity,0)<>saved.ordered_quantity
          AND (COALESCE(current_line.ordered_quantity,0)>saved.ordered_quantity
            OR COALESCE(current_line.ordered_quantity,0)<saved.matched_quantity
            OR saved.current_revision_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM inventory_order_quantity_corrections correction
            WHERE correction.order_id=saved.order_id AND correction.order_line_sku_id=saved.order_line_sku_id
              AND correction.source_order_revision=orders.source_revision)
          AND NOT EXISTS (SELECT 1 FROM inventory_stock_dispositions disposition
            JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
            WHERE disposition.order_id=saved.order_id AND disposition.order_line_sku_id=saved.order_line_sku_id
              AND correction.source_order_revision=orders.source_revision)
        ORDER BY orders.order_time,orders.order_number"#,
    )
    .bind(seller)
    .bind(sku)
    .bind(history_from)
    .fetch_all(&mut *conn)
    .await?;
    let dispositions: Vec<Restock> = sqlx::query_as(
        r#"SELECT disposition.id::text AS id,disposition.order_id::text AS "orderId",
        disposition.order_line_sku_id AS "skuId",disposition.disposition_type AS type,mapping.receipt_id AS "receiptId",
        mapping.source_supply_key AS "sourceSupplyKey",mapping.quantity,
        'restock:'||disposition.id::text||':'||mapping.source_supply_key AS "restockSupplyKey",
        EXISTS (SELECT 1 FROM inventory_stock_disposition_corrections correction
          WHERE correction.disposition_id=disposition.id) AS corrected FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2"#,
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    let quantity_corrections: Vec<Restock> = sqlx::query_as(
        r#"SELECT correction.id::text AS id,correction.order_id::text AS "orderId",
        correction.order_line_sku_id AS "skuId",NULL::text AS type,mapping.receipt_id AS "receiptId",
        mapping.source_supply_key AS "sourceSupplyKey",mapping.quantity,
        'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key AS "restockSupplyKey",
        false AS corrected
        FROM inventory_order_quantity_corrections correction
        JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
        WHERE correction.seller_key=$1 AND correction.sku=$2"#,
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    let supplies: Vec<Supply> = sqlx::query_as(
        r#"WITH raw_supply AS (
        SELECT 'receipt:'||receipt.receipt_id::text AS "supplyKey",
          receipt.receipt_id AS "receiptId",NULL::text AS "dispositionId",NULL::text AS "quantityCorrectionId",
          COALESCE(coverage.unknown_quantity,receipt.original_quantity) AS quantity,
          COALESCE(coverage.covered_from,opening.cutoff_at) AS "availableAt",receipt.fifo_precedence AS "fifoPrecedence",
          receipt.intake_at AS "intakeAt",receipt.market_value::text AS "marketValue"
        FROM inventory_receipts receipt JOIN inventory_opening_balance_runs opening
          ON opening.id=receipt.opening_balance_run_id AND opening.status='applied'
        LEFT JOIN inventory_listing_history_coverage coverage ON coverage.opening_receipt_id=receipt.receipt_id
        WHERE receipt.seller_key=$1 AND receipt.sku=$2 AND receipt.receipt_kind='opening_balance'
        UNION ALL
        SELECT 'receipt:'||receipt.receipt_id::text,receipt.receipt_id,NULL::text,NULL::text,link.planned_quantity,
          link.live_at,receipt.fifo_precedence,receipt.intake_at,receipt.market_value::text
        FROM inventory_receipts receipt JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
        WHERE receipt.seller_key=$1 AND link.target_seller_key=$1 AND receipt.sku=$2
          AND receipt.receipt_kind='received' AND link.live_at IS NOT NULL AND link.live_at>=$3
        UNION ALL
        SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key,mapping.receipt_id,
          disposition.id::text,NULL::text,mapping.quantity,disposition.available_at,receipt.fifo_precedence,
          receipt.intake_at,receipt.market_value::text
        FROM inventory_stock_dispositions disposition
        JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
        WHERE disposition.seller_key=$1 AND disposition.sku=$2
        UNION ALL
        SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key,mapping.receipt_id,
          NULL::text,correction.id::text,mapping.quantity,correction.available_at,receipt.fifo_precedence,
          receipt.intake_at,receipt.market_value::text
        FROM inventory_order_quantity_corrections correction
        JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
        JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
        WHERE correction.seller_key=$1 AND correction.sku=$2
      ) SELECT raw_supply."supplyKey",raw_supply."receiptId",raw_supply."dispositionId",raw_supply."quantityCorrectionId",
          (raw_supply.quantity-COALESCE((SELECT SUM(mapping.quantity)::int
            FROM (
              SELECT mapping.source_supply_key,mapping.quantity,disposition.seller_key,disposition.sku
              FROM inventory_stock_disposition_receipts mapping
              JOIN inventory_stock_dispositions disposition ON disposition.id=mapping.disposition_id
              JOIN inventory_stock_disposition_corrections correction ON correction.disposition_id=disposition.id
              UNION ALL
              SELECT mapping.source_supply_key,mapping.quantity,correction.seller_key,correction.sku
              FROM inventory_order_quantity_correction_allocations mapping
              JOIN inventory_order_quantity_corrections correction ON correction.id=mapping.correction_id
            ) mapping WHERE mapping.source_supply_key=raw_supply."supplyKey"
              AND mapping.seller_key=$1 AND mapping.sku=$2),0))::int AS quantity,
          raw_supply."availableAt",raw_supply."fifoPrecedence",raw_supply."intakeAt",raw_supply."marketValue"
        FROM raw_supply"#,
    )
    .bind(seller)
    .bind(sku)
    .bind(history_from)
    .fetch_all(&mut *conn)
    .await?;
    let shipped_orders: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT revision.order_id::text
        FROM seller_order_revisions revision JOIN seller_orders orders ON orders.id=revision.order_id
        WHERE orders.seller_key=$1 AND revision.lifecycle IN ('shipped_in_transit','shipped_delivered')
          AND (EXISTS (SELECT 1 FROM seller_order_lines line WHERE line.order_id=orders.id
              AND line.sku_id=$2::text)
            OR EXISTS (SELECT 1 FROM inventory_fifo_lines line WHERE line.order_id=orders.id AND line.sku=$2::integer))"#,
    )
    .bind(seller)
    .bind(sku)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Ok(Inputs {
        history_from,
        demand,
        quantity_changes,
        dispositions,
        quantity_corrections,
        supplies,
        shipped_orders: shipped_orders.into_iter().collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a test time")
            .with_timezone(&Utc)
    }

    const CUTOFF: &str = "2026-01-01T00:00:00.000Z";

    fn sold(order_id: &str, lifecycle: &str, quantity: i32, order_time: &str) -> Demand {
        Demand {
            order_id: order_id.into(),
            order_number: format!("N-{order_id}"),
            order_time: at(order_time),
            lifecycle: lifecycle.into(),
            source_revision: 1,
            sku_id: "100".into(),
            quantity,
        }
    }

    fn stock(receipt_id: i32, quantity: i32) -> Supply {
        Supply {
            supply_key: format!("receipt:{receipt_id}"),
            receipt_id,
            disposition_id: None,
            quantity_correction_id: None,
            quantity,
            available_at: at(CUTOFF),
            fifo_precedence: 1,
            intake_at: Some(at("2025-12-01T00:00:00.000Z")),
            market_value: Some("1.2345".into()),
        }
    }

    fn inputs(demand: Vec<Demand>, supplies: Vec<Supply>) -> Inputs {
        Inputs {
            history_from: at(CUTOFF),
            demand,
            supplies,
            ..Inputs::default()
        }
    }

    fn lines(replay: Replay) -> Vec<SavedLine> {
        match replay {
            Replay::Saved { lines, held: None } => lines,
            other => panic!("expected saved lines, got {other:?}"),
        }
    }

    /// The expected value is Node's `lineFingerprint` run on the same line.
    #[test]
    fn fingerprints_as_node_does() {
        let line = SavedLine {
            order_id: "1".into(),
            sku_id: "100".into(),
            order_time: at("2026-09-07T00:00:00-05:00"),
            ordered_quantity: 3,
            source_order_revision: 2,
            state: "partial",
            hold_reason: None,
            matched_quantity: 2,
            unmatched_quantity: 1,
            price_known_quantity: 2,
            date_known_quantity: 1,
            intake_market_total: Some(js_to_fixed(1235.0 / 100.0, 2)),
            weighted_days_held: Some(js_to_fixed(43.33333333333333, 6)),
            allocations: vec![
                Allocation {
                    supply_key: "receipt:7".into(),
                    receipt_id: 7,
                    disposition_id: None,
                    quantity_correction_id: None,
                    quantity: 1,
                    available_at: at("2026-01-01T00:00:00.000Z"),
                },
                Allocation {
                    supply_key: "restock:4:receipt:8".into(),
                    receipt_id: 8,
                    disposition_id: Some("4".into()),
                    quantity_correction_id: None,
                    quantity: 1,
                    available_at: at("2026-08-01T12:30:00.250Z"),
                },
            ],
        };
        assert_eq!(
            fingerprint(&line),
            "564853035e776339c732cf79d4270cb9676da9fc23c9a042d2bb46ff0f2d6479"
        );
    }

    #[test]
    fn states_each_kind_of_line() {
        let replay = plan(&inputs(
            vec![
                sold("1", "shipped_delivered", 2, "2026-02-01T00:00:00Z"),
                sold("2", "processing", 2, "2026-02-02T00:00:00Z"),
                sold("3", "canceled", 1, "2026-02-03T00:00:00Z"),
                sold("4", "shipped_delivered", 1, "2025-12-15T00:00:00Z"),
                sold("5", "shipped_delivered", 0, "2026-02-04T00:00:00Z"),
                sold("6", "lost_in_space", 1, "2026-02-05T00:00:00Z"),
            ],
            vec![stock(1, 3)],
        ))
        .unwrap();
        let states: Vec<_> = lines(replay)
            .iter()
            .map(|l| (l.order_id.clone(), l.state, l.hold_reason.clone()))
            .collect();
        assert_eq!(
            states,
            [
                ("1".into(), "allocated", None),
                ("2".into(), "partial", None),
                ("3".into(), "canceled_unfulfilled", None),
                ("4".into(), "excluded_pre_cutoff", None),
                ("5".into(), "removed", None),
                ("6".into(), "held", Some("unknown_order_lifecycle".into())),
            ]
        );
    }

    #[test]
    fn writes_totals_as_node_does() {
        let line = lines(
            plan(&inputs(
                vec![sold("1", "processing", 2, "2026-01-11T00:00:00Z")],
                vec![stock(1, 2)],
            ))
            .unwrap(),
        )
        .remove(0);
        // 2 x 1.2345 = 2.469, rounded to the cent.
        assert_eq!(line.intake_market_total.as_deref(), Some("2.47"));
        assert_eq!(line.weighted_days_held.as_deref(), Some("41.000000"));
    }

    #[test]
    fn a_shipped_cancellation_is_a_sale_until_restocked() {
        let mut shipped = inputs(
            vec![sold("1", "canceled", 1, "2026-02-01T00:00:00Z")],
            vec![stock(1, 1)],
        );
        shipped.shipped_orders.insert("1".into());
        assert_eq!(lines(plan(&shipped).unwrap())[0].state, "allocated");
        shipped.dispositions.push(Restock {
            id: "9".into(),
            order_id: "1".into(),
            sku_id: "100".into(),
            kind: Some("unfulfilled_cancellation".into()),
            receipt_id: 1,
            source_supply_key: "receipt:1".into(),
            quantity: 1,
            restock_supply_key: "restock:9:receipt:1".into(),
            corrected: false,
        });
        let held = lines(plan(&shipped).unwrap()).remove(0);
        assert_eq!(held.state, "held");
        assert_eq!(
            held.hold_reason.as_deref(),
            Some("canceled_after_shipping_requires_restock")
        );
    }

    #[test]
    fn holds_a_restock_of_more_than_was_matched() {
        let mut restocked = inputs(
            vec![sold("1", "canceled", 1, "2026-02-01T00:00:00Z")],
            Vec::new(),
        );
        restocked.dispositions.push(Restock {
            id: "9".into(),
            order_id: "1".into(),
            sku_id: "100".into(),
            kind: Some("physical_restock".into()),
            receipt_id: 1,
            source_supply_key: "receipt:1".into(),
            quantity: 1,
            restock_supply_key: "restock:9:receipt:1".into(),
            corrected: false,
        });
        assert_eq!(
            plan(&restocked).unwrap(),
            Replay::Held("restock_lineage_conflict:9".into())
        );
    }

    #[test]
    fn an_unprojected_decrease_is_saved_at_its_old_quantity_then_held() {
        let mut decreased = inputs(
            vec![sold("1", "processing", 1, "2026-02-01T00:00:00Z")],
            vec![stock(1, 5)],
        );
        decreased.quantity_changes.push(QuantityChange {
            line_id: "77".into(),
            order_id: "1".into(),
            sku_id: "100".into(),
            direction: "decrease".into(),
            needs_initial_projection: true,
            previous_quantity: 3,
            previous_order_time: at("2026-02-01T00:00:00Z"),
            previous_source_revision: 1,
        });
        let Replay::Saved { lines, held } = plan(&decreased).unwrap() else {
            panic!("expected saved lines")
        };
        assert_eq!(
            held.as_deref(),
            Some("order_quantity_decrease_requires_correction:77")
        );
        assert_eq!(
            (
                lines[0].ordered_quantity,
                lines[0].matched_quantity,
                lines[0].state
            ),
            (3, 3, "held")
        );
        decreased.quantity_changes[0].needs_initial_projection = false;
        assert_eq!(
            plan(&decreased).unwrap(),
            Replay::Held("order_quantity_decrease_requires_correction:77".into())
        );
    }
}
