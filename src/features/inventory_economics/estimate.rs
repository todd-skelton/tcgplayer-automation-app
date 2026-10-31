//! Estimated purchase costs, ported from `estimatedPurchaseCost.ts` and
//! `recordEstimatedPurchaseCosts`: a batch with no entered purchase cost is costed at a share of
//! each card's market price at intake, less a fixed amount per card. Node still records the
//! estimates; [`plan`] says what it would record, so the two can be compared before the switch.
use std::{collections::BTreeMap, io::Write, path::PathBuf, time::Duration};

use chrono::{DateTime, Utc};
use corten::Signal;
use serde::{Deserialize, Serialize};
use tokio::time::{MissedTickBehavior, interval};

use crate::database::Database;

/// How an estimate turns a card's market price at intake into its cost: a share of it, less a
/// fixed amount per card.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRate {
    /// From 0 to 1.
    pub market_rate: f64,
    pub per_unit_deduction_cents: i64,
}

impl CostRate {
    /// 75% of market less $0.30 per card.
    pub const DEFAULT: CostRate = CostRate {
        market_rate: 0.75,
        per_unit_deduction_cents: 30,
    };

    /// The percent of market as entered: `75`, `60.5`, `33.33`.
    pub fn market_percent(self) -> String {
        let hundredths = (self.market_rate * 10_000.0).round() as i64;
        match (hundredths % 100, hundredths % 10) {
            (0, _) => format!("{}", hundredths / 100),
            (_, 0) => format!("{}.{}", hundredths / 100, (hundredths % 100) / 10),
            _ => format!("{}.{:02}", hundredths / 100, hundredths % 100),
        }
    }

    /// The amount less per card as entered: `0.30`.
    pub fn per_card_deduction(self) -> String {
        format!("{:.2}", self.per_unit_deduction_cents as f64 / 100.0)
    }

    /// `60% of market less $0.50 per card`.
    pub fn describe(self) -> String {
        format!(
            "{}% of market less ${} per card",
            self.market_percent(),
            self.per_card_deduction()
        )
    }
}

/// The rule every estimate's request id names, so a rule change re-estimates rather than repeats.
pub const RULE_VERSION: &str = "market-rate-v2";

/// JavaScript's `Math.round` for the nonnegative amounts it is used on here: halves go up.
fn js_round(value: f64) -> i64 {
    value.round() as i64
}

/// One card's cost in cents: the rate's share of its market, less the deduction. A card worth
/// less than the deduction costs less than nothing.
pub fn unit_cost_cents(market_value: f64, rate: CostRate) -> i64 {
    let market_cents = js_round(market_value * 100.0);
    js_round(market_cents as f64 * rate.market_rate) - rate.per_unit_deduction_cents
}

/// Names the rule and, when the batch overrides it, the rate.
pub fn request_id(batch_number: i32, rate: CostRate) -> String {
    let base = format!("estimated-purchase-cost:{RULE_VERSION}:batch-{batch_number}");
    if rate == CostRate::DEFAULT {
        base
    } else {
        format!(
            "{base}:market-{}-less-{}c",
            rate.market_rate, rate.per_unit_deduction_cents
        )
    }
}

/// A correction names the entry it corrects.
pub fn correction_request_id(request_id: &str, corrects_entry_id: &str) -> String {
    format!("{request_id}:corrects-{corrects_entry_id}")
}

/// Whether the current entry was recorded for this request, directly or as a correction.
pub fn recorded_for(current_request_id: &str, request_id: &str) -> bool {
    current_request_id == request_id
        || current_request_id.starts_with(&format!("{request_id}:corrects-"))
}

/// A receipt lot of a batch, with what the current estimate allocated to it.
#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub receipt_id: i32,
    pub original_quantity: i32,
    /// The unit market at intake, or none when no quote was captured.
    pub market_value: Option<f64>,
    pub intake_at: Option<DateTime<Utc>>,
    pub allocated_amount_cents: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CurrentEstimate {
    pub entry_id: String,
    pub request_id: String,
}

/// A batch an estimate may cost: no purchase cost but its own estimate owns any of its lots.
#[derive(Clone, Debug, PartialEq)]
pub struct Batch {
    pub batch_number: i32,
    pub cost_rate: Option<CostRate>,
    pub current: Option<CurrentEstimate>,
    pub receipts: Vec<Receipt>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitAllocation {
    pub receipt_id: i32,
    pub amount_cents: i64,
}

/// The purchase cost Node's `recordPurchaseCost` is given, in its JSON shape.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurchaseCost {
    pub request_id: String,
    pub seller_key: String,
    pub purchase_reference: String,
    pub currency: &'static str,
    pub total_amount_cents: i64,
    pub provenance: &'static str,
    pub source: &'static str,
    pub allocation_rule: &'static str,
    pub batch_numbers: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purchased_at: Option<String>,
    pub explicit_allocations: Vec<ExplicitAllocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrects_entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correction_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    BatchNumber,
    NoReceipts,
    Quantity(i32),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BatchNumber => f.write_str("Batch number must be a positive integer."),
            Self::NoReceipts => {
                f.write_str("An estimated purchase cost requires at least one receipt lot.")
            }
            Self::Quantity(id) => write!(f, "Receipt {id} quantity must be a positive integer."),
        }
    }
}

/// `estimateBatchPurchaseCost`: the batch's purchase cost, or the lots with no market at intake.
pub fn estimate(
    seller: &str,
    batch_number: i32,
    receipts: &[Receipt],
    rate: CostRate,
) -> Result<Result<(PurchaseCost, i64), Vec<i32>>, Refused> {
    if batch_number <= 0 {
        return Err(Refused::BatchNumber);
    }
    if receipts.is_empty() {
        return Err(Refused::NoReceipts);
    }
    let missing: Vec<i32> = receipts
        .iter()
        .filter(|r| r.market_value.is_none())
        .map(|r| r.receipt_id)
        .collect();
    if !missing.is_empty() {
        return Ok(Err(missing));
    }
    let allocations = receipts
        .iter()
        .map(|receipt| {
            if receipt.original_quantity <= 0 {
                return Err(Refused::Quantity(receipt.receipt_id));
            }
            let unit = unit_cost_cents(receipt.market_value.unwrap_or_default(), rate);
            Ok(ExplicitAllocation {
                receipt_id: receipt.receipt_id,
                amount_cents: i64::from(receipt.original_quantity) * unit,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let purchased_at = receipts
        .iter()
        .filter_map(|r| r.intake_at)
        .min()
        .map(|at| at.format("%Y-%m-%d").to_string());
    let unit_count = receipts
        .iter()
        .map(|r| i64::from(r.original_quantity))
        .sum();
    Ok(Ok((
        PurchaseCost {
            request_id: request_id(batch_number, rate),
            seller_key: seller.to_owned(),
            purchase_reference: format!("estimated:batch-{batch_number}"),
            currency: "USD",
            total_amount_cents: allocations.iter().map(|a| a.amount_cents).sum(),
            provenance: "estimated",
            source: "intake",
            allocation_rule: "explicit",
            batch_numbers: vec![batch_number],
            purchased_at,
            explicit_allocations: allocations,
            corrects_entry_id: None,
            correction_reason: None,
        },
        unit_count,
    )))
}

/// What a run of `recordEstimatedPurchaseCosts` does with each batch, before anything is saved.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub would_record: Vec<PurchaseCost>,
    /// Batches already estimated under the current rule.
    pub repeated: Vec<i32>,
    /// Batches estimated under an earlier rule that the current one leaves the same.
    pub unchanged: Vec<i32>,
    pub market_unavailable: BTreeMap<i32, Vec<i32>>,
}

pub fn plan(seller: &str, batches: &[Batch]) -> Result<Run, Refused> {
    let mut run = Run::default();
    for batch in batches {
        let rate = batch.cost_rate.unwrap_or(CostRate::DEFAULT);
        let (mut cost, _) = match estimate(seller, batch.batch_number, &batch.receipts, rate)? {
            Ok(estimated) => estimated,
            Err(receipt_ids) => {
                run.market_unavailable
                    .insert(batch.batch_number, receipt_ids);
                continue;
            }
        };
        if let Some(current) = &batch.current {
            if recorded_for(&current.request_id, &cost.request_id) {
                run.repeated.push(batch.batch_number);
                continue;
            }
            let unchanged = cost.explicit_allocations.iter().all(|allocation| {
                batch
                    .receipts
                    .iter()
                    .find(|r| r.receipt_id == allocation.receipt_id)
                    .and_then(|r| r.allocated_amount_cents)
                    == Some(allocation.amount_cents as f64)
            });
            if unchanged {
                run.unchanged.push(batch.batch_number);
                continue;
            }
            cost.request_id = correction_request_id(&cost.request_id, &current.entry_id);
            cost.corrects_entry_id = Some(current.entry_id.clone());
            cost.correction_reason = Some(match batch.cost_rate {
                Some(rate) => format!(
                    "Re-estimated under rule {RULE_VERSION} at {}",
                    rate.describe()
                ),
                None => format!("Re-estimated under rule {RULE_VERSION}"),
            });
        }
        run.would_record.push(cost);
    }
    Ok(run)
}

#[derive(sqlx::FromRow)]
struct Row {
    batch_number: i32,
    receipt_id: i32,
    original_quantity: i32,
    market_value: Option<f64>,
    intake_at: Option<DateTime<Utc>>,
    entry_id: Option<String>,
    request_id: Option<String>,
    allocated_amount_cents: Option<f64>,
    cost_market_rate: Option<f64>,
    cost_per_unit_deduction_cents: Option<i32>,
}

/// `findEstimableBatchReceipts`: the seller's batches an estimate may cost, with their lots.
pub async fn estimable(
    db: impl sqlx::PgExecutor<'_>,
    seller: &str,
    batch_numbers: Option<&[i32]>,
    limit: i64,
) -> sqlx::Result<Vec<Batch>> {
    let rows: Vec<Row> = sqlx::query_as(
        r#"WITH batch_lot AS (
        SELECT link.batch_number,receipt.receipt_id,ownership.series_id,series.purchase_reference,series.seller_key AS owner
        FROM inventory_receipt_batch_links link
        JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
        LEFT JOIN inventory_purchase_receipt_ownership ownership ON ownership.receipt_id=receipt.receipt_id
        LEFT JOIN inventory_purchase_cost_series series ON series.id=ownership.series_id
        WHERE receipt.receipt_kind IN ('received','opening_balance')
          AND (receipt.seller_key IS NULL OR receipt.seller_key=$1)
          AND ($2::int[] IS NULL OR link.batch_number=ANY($2::int[]))
      ), estimable AS (
        SELECT batch_number,max(series_id) AS series_id
        FROM batch_lot
        GROUP BY batch_number
        HAVING NOT EXISTS (
          SELECT 1 FROM inventory_receipt_batch_links owned
          JOIN inventory_purchase_receipt_ownership ownership ON ownership.receipt_id=owned.receipt_id
          JOIN inventory_purchase_cost_series series ON series.id=ownership.series_id
          WHERE owned.batch_number=batch_lot.batch_number
            AND (series.seller_key<>$1 OR series.purchase_reference<>'estimated:batch-'||batch_lot.batch_number))
          AND count(DISTINCT series_id)<=1
        ORDER BY batch_number LIMIT $3
      ), current_entry AS (
        SELECT DISTINCT ON (entry.series_id) entry.id,entry.series_id,entry.request_id
        FROM inventory_purchase_cost_entries entry ORDER BY entry.series_id,entry.sequence DESC
      )
      SELECT link.batch_number,receipt.receipt_id,receipt.original_quantity,
        COALESCE(receipt.market_value,
          (SELECT weekly.tcg_market_price FROM product_weekly_sales weekly
           WHERE weekly.sku_id=receipt.sku AND weekly.tcg_market_price IS NOT NULL
             AND weekly.week_start<=COALESCE(receipt.intake_at::date,
               (SELECT observed.created_at::date FROM continuous_pricing_inventory observed
                WHERE observed.seller_key=$1 AND observed.sku=receipt.sku))
           ORDER BY weekly.week_start DESC LIMIT 1),
          (SELECT observed.market_price FROM continuous_pricing_inventory observed
           WHERE observed.seller_key=$1 AND observed.sku=receipt.sku AND observed.market_price IS NOT NULL LIMIT 1),
          (SELECT observed.current_price FROM continuous_pricing_inventory observed
           WHERE observed.seller_key=$1 AND observed.sku=receipt.sku AND observed.current_price IS NOT NULL LIMIT 1))::float8 AS market_value,
        receipt.intake_at,current.id::text AS entry_id,current.request_id,
        allocation.allocated_amount_cents::float8 AS allocated_amount_cents,
        rate.market_rate::float8 AS cost_market_rate,
        rate.per_unit_deduction_cents AS cost_per_unit_deduction_cents
      FROM estimable
      LEFT JOIN inventory_batch_estimated_cost_rates rate ON rate.batch_number=estimable.batch_number
      JOIN inventory_receipt_batch_links link ON link.batch_number=estimable.batch_number
      JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
      LEFT JOIN current_entry current ON current.series_id=estimable.series_id
      LEFT JOIN inventory_purchase_cost_allocations allocation
        ON allocation.entry_id=current.id AND allocation.receipt_id=receipt.receipt_id
      ORDER BY link.batch_number,receipt.receipt_id"#,
    )
    .bind(seller)
    .bind(batch_numbers)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let mut batches: Vec<Batch> = Vec::new();
    for row in rows {
        if batches
            .last()
            .is_none_or(|b| b.batch_number != row.batch_number)
        {
            batches.push(Batch {
                batch_number: row.batch_number,
                cost_rate: row
                    .cost_market_rate
                    .zip(row.cost_per_unit_deduction_cents)
                    .map(|(market_rate, cents)| CostRate {
                        market_rate,
                        per_unit_deduction_cents: cents.into(),
                    }),
                current: None,
                receipts: Vec::new(),
            });
        }
        let batch = batches.last_mut().expect("a batch was just pushed");
        if let (Some(entry_id), Some(request_id)) = (row.entry_id, row.request_id) {
            batch.current = Some(CurrentEstimate {
                entry_id,
                request_id,
            });
        }
        batch.receipts.push(Receipt {
            receipt_id: row.receipt_id,
            original_quantity: row.original_quantity,
            market_value: row.market_value,
            intake_at: row.intake_at,
            allocated_amount_cents: row.allocated_amount_cents,
        });
    }
    Ok(batches)
}

/// `findUncostedBatchNumbers`: batches with a lot no purchase cost owns yet.
pub async fn uncosted(db: impl sqlx::PgExecutor<'_>, seller: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        "SELECT DISTINCT link.batch_number
      FROM inventory_receipt_batch_links link
      JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
      WHERE receipt.receipt_kind IN ('received','opening_balance')
        AND (receipt.seller_key IS NULL OR receipt.seller_key=$1)
        AND NOT EXISTS (SELECT 1 FROM inventory_purchase_receipt_ownership ownership
          WHERE ownership.receipt_id=receipt.receipt_id)
      ORDER BY 1 LIMIT 100",
    )
    .bind(seller)
    .fetch_all(db)
    .await
}

/// How often the shadow looks for batches Node's worker would estimate. Node looks every cycle.
pub const EVERY: Duration = Duration::from_secs(60 * 60);

/// What the worker's run would record now: the uncosted batches' estimates, or none.
pub async fn worker_run(db: &Database, seller: &str) -> Result<Option<Run>, String> {
    let missing = uncosted(&db.0, seller).await.map_err(|e| e.to_string())?;
    if missing.is_empty() {
        return Ok(None);
    }
    let batches = estimable(&db.0, seller, Some(&missing), 100)
        .await
        .map_err(|e| e.to_string())?;
    plan(seller, &batches).map(Some).map_err(|e| e.to_string())
}

/// An estimate a run saved.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorded {
    pub batch_number: i32,
    pub entry_id: String,
    pub total_amount_cents: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrects_entry_id: Option<String>,
}

/// What a run of `recordEstimatedPurchaseCosts` did with each batch.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimated {
    pub recorded: Vec<Recorded>,
    /// Batches already estimated under the current rule.
    pub repeated: Vec<i32>,
    /// Batches estimated under an earlier rule that the current one leaves the same.
    pub unchanged: Vec<i32>,
    pub market_unavailable: BTreeMap<i32, Vec<i32>>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the seller order history worker's cycle calls it once its sync store is ported"
    )
)]
/// `recordMissingEstimatedPurchaseCosts`: estimates every batch with a lot no purchase cost owns
/// yet, or does nothing when there is none. Each estimate is saved in a transaction of its own on
/// `conn` (a savepoint when `conn` is already in one), so one that fails keeps those before it.
pub async fn record_missing(
    conn: &mut sqlx::PgConnection,
    seller: &str,
) -> Result<Option<Estimated>, String> {
    use sqlx::Connection;
    let failed = |e: sqlx::Error| e.to_string();
    let missing = uncosted(&mut *conn, seller).await.map_err(failed)?;
    if missing.is_empty() {
        return Ok(None);
    }
    let batches = estimable(&mut *conn, seller, Some(&missing), 100)
        .await
        .map_err(failed)?;
    let run = plan(seller, &batches).map_err(|e| e.to_string())?;
    let mut estimated = Estimated {
        recorded: Vec::new(),
        repeated: run.repeated,
        unchanged: run.unchanged,
        market_unavailable: run.market_unavailable,
    };
    for cost in run.would_record {
        let mut tx = conn.begin().await.map_err(failed)?;
        let saved = super::purchase_cost::record(&mut tx, &cost).await?;
        tx.commit().await.map_err(failed)?;
        let batch_number = cost.batch_numbers[0];
        if saved.repeated {
            estimated.repeated.push(batch_number);
        } else {
            estimated.recorded.push(Recorded {
                batch_number,
                entry_id: saved.entry_id,
                total_amount_cents: cost.total_amount_cents,
                corrects_entry_id: cost.corrects_entry_id,
            });
        }
    }
    Ok(Some(estimated))
}

/// The log `ESTIMATE_SHADOW_LOG` names: the shadow runs only when it is set.
pub fn log_path() -> Option<PathBuf> {
    std::env::var("ESTIMATE_SHADOW_LOG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// The task: what the worker's run would record is appended to `log` as one JSON line at once,
/// then every [`EVERY`]. It writes nothing else.
pub async fn run(db: Database, log: PathBuf, signal: Signal) {
    println!(
        "Estimated purchase cost shadow: logging to {}",
        log.display()
    );
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        let logged = async {
            let seller = crate::features::shipping_configuration::default_seller_key(&db)
                .await
                .map_err(|e| e.to_string())?;
            let run = worker_run(&db, seller.trim()).await?;
            let line = serde_json::json!({ "at": Utc::now().to_rfc3339(), "run": run });
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .map_err(|e| e.to_string())?;
            writeln!(file, "{line}").map_err(|e| e.to_string())
        };
        // A run only reads, so shutdown can drop it.
        let logged = tokio::select! {
            biased;
            _ = signal.aborted() => return,
            logged = logged => logged,
        };
        if let Err(why) = logged {
            eprintln!("Estimated purchase cost shadow failed: {why}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(text)
            .expect("a test time")
            .with_timezone(&Utc)
    }

    fn lot(
        receipt_id: i32,
        original_quantity: i32,
        market_value: Option<f64>,
        intake_at: Option<&str>,
    ) -> Receipt {
        Receipt {
            receipt_id,
            original_quantity,
            market_value,
            intake_at: intake_at.map(at),
            allocated_amount_cents: None,
        }
    }

    const SIXTY_LESS_FIFTY: CostRate = CostRate {
        market_rate: 0.6,
        per_unit_deduction_cents: 50,
    };

    /// Writes what the worker's run and a run over every estimable batch would record to
    /// `ESTIMATE_SHADOW_OUT`, for `.port-logs/estimate-parity.ts` to compare with Node's.
    #[tokio::test]
    #[ignore = "reads the dev database"]
    async fn writes_what_a_run_would_record() {
        crate::config::load_env();
        let out = std::env::var("ESTIMATE_SHADOW_OUT").expect("ESTIMATE_SHADOW_OUT names the file");
        let db = Database::connect_lazy(&crate::config::database_url());
        let seller = crate::features::shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let seller = seller.trim();
        let missing = uncosted(&db.0, seller).await.unwrap();
        let worker = if missing.is_empty() {
            None
        } else {
            Some(
                plan(
                    seller,
                    &estimable(&db.0, seller, Some(&missing), 100).await.unwrap(),
                )
                .unwrap(),
            )
        };
        let all = plan(seller, &estimable(&db.0, seller, None, 1000).await.unwrap()).unwrap();
        let json = serde_json::json!({ "worker": worker, "all": all });
        std::fs::write(out, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    }

    /// Records what the worker would on the dev database, in a transaction it rolls back, and
    /// compares what it wrote with what Node's `recordMissingEstimatedPurchaseCosts` wrote
    /// (`.port-logs/estimate-record-node.ts`, captured by `.port-logs/estimate-capture.sql`).
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn records_missing_estimates_as_node_does() {
        crate::config::load_env();
        let node: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/estimate-record.node.json").unwrap(),
        )
        .unwrap();
        let capture = std::fs::read_to_string(".port-logs/estimate-capture.sql").unwrap();
        let db = Database::connect_lazy(&crate::config::database_url());
        let seller = crate::features::shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let mut tx = db.0.begin().await.unwrap();
        let estimated = record_missing(&mut tx, seller.trim()).await.unwrap();
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let result = estimated.map(|e| {
            serde_json::json!({
                "recorded": e.recorded.iter().map(|r| r.batch_number).collect::<Vec<_>>(),
                "repeated": e.repeated,
                "unchanged": e.unchanged,
                "marketUnavailable": e.market_unavailable,
            })
        });
        let captured: serde_json::Value = serde_json::from_str(&captured).unwrap();
        println!(
            "recorded {:?}; {} entries, {} lots owned",
            result.as_ref().map(|r| &r["recorded"]),
            captured["entries"].as_array().map_or(0, Vec::len),
            captured["owned"].as_array().map_or(0, Vec::len),
        );
        assert_eq!(result.unwrap_or_default(), node["result"]);
        assert_eq!(captured, node["captured"]);
    }

    #[test]
    fn a_unit_costs_its_share_of_market_less_the_deduction() {
        let d = CostRate::DEFAULT;
        assert_eq!(unit_cost_cents(10.0, d), 720);
        assert_eq!(unit_cost_cents(0.4, d), 0);
        assert_eq!(unit_cost_cents(0.39, d), -1);
        assert_eq!(unit_cost_cents(1.234, d), 62);
        assert_eq!(unit_cost_cents(0.0, d), -30);
        assert_eq!(unit_cost_cents(10.0, SIXTY_LESS_FIFTY), 550);
    }

    #[test]
    fn a_batch_is_costed_lot_by_lot_from_its_earliest_intake() {
        let (cost, units) = estimate(
            "seller-a",
            12,
            &[
                lot(5, 3, Some(10.0), Some("2026-08-11T03:00:00Z")),
                lot(7, 1, Some(0.2), Some("2026-08-10T23:30:00Z")),
            ],
            CostRate::DEFAULT,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            serde_json::to_value(&cost).unwrap(),
            serde_json::json!({
                "requestId": "estimated-purchase-cost:market-rate-v2:batch-12",
                "sellerKey": "seller-a",
                "purchaseReference": "estimated:batch-12",
                "currency": "USD",
                "totalAmountCents": 2145,
                "provenance": "estimated",
                "source": "intake",
                "allocationRule": "explicit",
                "batchNumbers": [12],
                "purchasedAt": "2026-08-10",
                "explicitAllocations": [{ "receiptId": 5, "amountCents": 2160 }, { "receiptId": 7, "amountCents": -15 }],
            })
        );
        assert_eq!(units, 4);
        let (undated, _) = estimate(
            "seller-a",
            13,
            &[lot(9, 2, Some(4.0), None)],
            CostRate::DEFAULT,
        )
        .unwrap()
        .unwrap();
        assert!(
            !serde_json::to_value(&undated)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("purchasedAt")
        );
        let (at_rate, _) = estimate(
            "seller-a",
            12,
            &[lot(5, 3, Some(10.0), None)],
            SIXTY_LESS_FIFTY,
        )
        .unwrap()
        .unwrap();
        assert_eq!(at_rate.total_amount_cents, 1650);
    }

    #[test]
    fn a_batch_with_an_unquoted_lot_is_not_estimated() {
        let lots = [lot(1, 1, Some(5.0), None), lot(2, 1, None, None)];
        assert_eq!(
            estimate("seller-a", 14, &lots, CostRate::DEFAULT),
            Ok(Err(vec![2]))
        );
        assert_eq!(
            estimate("seller-a", 15, &[], CostRate::DEFAULT),
            Err(Refused::NoReceipts)
        );
    }

    #[test]
    fn request_ids_name_the_rule_the_rate_and_what_they_correct() {
        assert_eq!(
            request_id(12, CostRate::DEFAULT),
            "estimated-purchase-cost:market-rate-v2:batch-12"
        );
        let rate_id = request_id(12, SIXTY_LESS_FIFTY);
        assert_eq!(
            rate_id,
            "estimated-purchase-cost:market-rate-v2:batch-12:market-0.6-less-50c"
        );
        assert_eq!(
            correction_request_id(&rate_id, "41"),
            format!("{rate_id}:corrects-41")
        );
        assert!(recorded_for(&rate_id, &rate_id));
        assert!(recorded_for(&format!("{rate_id}:corrects-41"), &rate_id));
        assert!(!recorded_for(&rate_id, &request_id(12, CostRate::DEFAULT)));
        assert!(!recorded_for(
            &format!("{}:corrects-4", request_id(120, CostRate::DEFAULT)),
            &request_id(12, CostRate::DEFAULT)
        ));
    }

    #[test]
    fn a_run_repeats_keeps_or_corrects_an_earlier_estimate() {
        let batch = |current: &str, allocated: f64, rate: Option<CostRate>| Batch {
            batch_number: 12,
            cost_rate: rate,
            current: Some(CurrentEstimate {
                entry_id: "41".into(),
                request_id: current.into(),
            }),
            receipts: vec![Receipt {
                allocated_amount_cents: Some(allocated),
                ..lot(5, 3, Some(10.0), None)
            }],
        };
        let default_id = request_id(12, CostRate::DEFAULT);
        let run = plan("seller-a", &[batch(&default_id, 0.0, None)]).unwrap();
        assert_eq!(run.repeated, [12]);
        let run = plan(
            "seller-a",
            &[batch(
                "estimated-purchase-cost:market-rate-v1:batch-12",
                2160.0,
                None,
            )],
        )
        .unwrap();
        assert_eq!(run.unchanged, [12]);
        let run = plan(
            "seller-a",
            &[batch(&default_id, 2160.0, Some(SIXTY_LESS_FIFTY))],
        )
        .unwrap();
        let corrected = &run.would_record[0];
        assert_eq!(
            corrected.request_id,
            format!("{}:corrects-41", request_id(12, SIXTY_LESS_FIFTY))
        );
        assert_eq!(corrected.corrects_entry_id.as_deref(), Some("41"));
        assert_eq!(
            corrected.correction_reason.as_deref(),
            Some("Re-estimated under rule market-rate-v2 at 60% of market less $0.50 per card")
        );
    }
}
