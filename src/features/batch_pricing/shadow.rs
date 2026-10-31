//! A replay of Node's finished pricing jobs from the ledgers, compared with the results Node saved,
//! as JSON lines. It writes nothing to the database and does not call TCGplayer.
//!
//! This is a diagnostic, not the parity gate. The ledgers do not hold what a job read: listings
//! are kept only as each condition's two cheapest asks, and the sales ledger keeps sales that
//! TCGplayer later drops. Measured on 2026-10-30, Node's own pricer replayed on the ledgers for 20
//! jobs disagreed with its saved prices on 124 of 135 SKUs, while Rust and Node agree on every
//! value when given the same evidence (`pricing::parity`). Parity is proven on identical inputs;
//! this shows how far the ledgers are from a job's real inputs.
//!
//! [`run`] is the background form, off unless `BATCH_PRICING_SHADOW_LOG` names the log; it is not
//! registered while the replay cannot be a gate.
use std::{collections::HashMap, io::Write, path::PathBuf, time::Duration};

use chrono::{DateTime, Utc};
use corten::Signal;
use serde::Serialize;
use serde_json::Value;
use tokio::time::{MissedTickBehavior, interval};

use super::job::{self, Batch, MarketData, Mode, PricePoint, PricedSku};
use super::results;
use crate::{
    database::Database,
    features::{
        configuration::config::Config as StoredConfig,
        pricing::{
            buyer_arrival_rate::LATEST_SALES_LIMIT,
            policy::SupplyStatus,
            sale::Sale,
            sku_price::{Evidence, Failure, History, HistoryBucket, Sku},
            supply_analysis::Observation as Supply,
        },
    },
};

/// How often finished jobs are looked for.
pub const EVERY: Duration = Duration::from_secs(60);

fn log_path() -> Option<PathBuf> {
    std::env::var("BATCH_PRICING_SHADOW_LOG")
        .ok()
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
}

/// A job Node's worker finished.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Finished {
    pub id: i64,
    pub batch_number: i32,
    pub mode: String,
    pub config_json: Value,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
}

/// The ledgers as they stood when a job finished.
pub struct Ledgers<'a> {
    pub db: &'a Database,
    pub as_of: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct SaleRow {
    condition: String,
    variant: String,
    language: String,
    quantity: i32,
    purchase_price: f64,
    shipping_price: f64,
    listing_type: String,
    custom_listing_id: String,
    order_date: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct WeekRow {
    sku_id: i32,
    condition: String,
    variant: String,
    language: String,
    week: String,
    transactions: i32,
    market: Option<f64>,
}

impl Evidence for Ledgers<'_> {
    async fn latest_sales(&self, sku: &Sku) -> Result<Vec<Sale>, Failure> {
        let rows: Vec<SaleRow> = sqlx::query_as(
            "SELECT condition, variant, language, quantity, purchase_price::float8 AS purchase_price,
                    shipping_price::float8 AS shipping_price, listing_type, custom_listing_id, order_date
             FROM product_sales
             WHERE product_id = $1 AND variant = $2 AND language = $3
               AND first_seen_at <= $4 AND order_date <= $4
             ORDER BY order_date DESC LIMIT $5",
        )
        .bind(sku.product_id as i32)
        .bind(&sku.variant)
        .bind(&sku.language)
        .bind(self.as_of)
        .bind(LATEST_SALES_LIMIT as i64)
        .fetch_all(&self.db.0)
        .await
        .map_err(|e| Failure::Sku(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|r| Sale {
                condition: r.condition,
                variant: r.variant,
                language: r.language,
                quantity: r.quantity.into(),
                title: String::new(),
                listing_type: r.listing_type,
                custom_listing_id: r.custom_listing_id,
                purchase_price: r.purchase_price,
                shipping_price: r.shipping_price,
                order_date: r
                    .order_date
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            })
            .collect())
    }

    async fn price_history(&self, product_id: i64) -> Option<Vec<History>> {
        let weeks: Vec<WeekRow> = sqlx::query_as(
            "SELECT sku_id, condition, variant, language, to_char(week_start, 'YYYY-MM-DD') AS week,
                    transactions, tcg_market_price::float8 AS market
             FROM product_weekly_sales WHERE product_id = $1 AND week_start <= $2::date
             ORDER BY sku_id, week_start DESC",
        )
        .bind(product_id as i32)
        .bind(self.as_of)
        .fetch_all(&self.db.0)
        .await
        .inspect_err(|e| eprintln!("Batch pricing shadow: weekly sales of {product_id} failed: {e}"))
        .ok()?;
        let mut skus: Vec<History> = Vec::new();
        for week in weeks {
            let bucket = HistoryBucket {
                market_price: week.market.unwrap_or(0.0),
                transaction_count: week.transactions.into(),
                bucket_start_date: week.week,
            };
            match skus
                .last_mut()
                .filter(|h| h.sku_id == i64::from(week.sku_id))
            {
                Some(history) => history.buckets.push(bucket),
                None => skus.push(History {
                    sku_id: week.sku_id.into(),
                    condition: week.condition,
                    variant: week.variant,
                    language: week.language,
                    buckets: vec![bucket],
                }),
            }
        }
        (!skus.is_empty()).then_some(skus)
    }

    async fn listings(&self, _: &Sku, _: Option<f64>, _: Option<&str>) -> Supply {
        Supply {
            status: SupplyStatus::Unavailable,
            listings: Vec::new(),
        }
    }

    async fn lowest_listing_price(&self, _: &Sku, _: Option<&str>) -> Option<f64> {
        None
    }
}

/// What Node saved for a SKU.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Saved {
    pub sku: i32,
    pub result_status: String,
    pub row_json: Value,
    pub pricing_details_json: Option<Value>,
}

pub async fn saved(db: &Database, batch_number: i32) -> Result<Vec<Saved>, String> {
    sqlx::query_as(
        "SELECT sku, result_status, row_json, pricing_details_json
         FROM inventory_batch_results WHERE batch_number = $1",
    )
    .bind(batch_number)
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())
}

/// Node's market data, read back from the results it saved.
pub struct SavedMarket<'a>(pub &'a [Saved]);

impl MarketData for SavedMarket<'_> {
    async fn price_points(&self, _: &[i64]) -> Result<HashMap<i64, PricePoint>, String> {
        Ok(self
            .0
            .iter()
            .filter_map(|s| {
                let details = s.pricing_details_json.as_ref()?;
                let market_price = details.get("tcgMarketPrice")?.as_f64()?;
                let number = |key: &str| details.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                let sale_count = s.row_json["Sale Count"]
                    .as_str()
                    .and_then(|c| c.parse().ok())
                    .unwrap_or(0.0);
                Some((
                    i64::from(s.sku),
                    PricePoint {
                        market_price,
                        lowest_price: number("lowestSalePrice"),
                        highest_price: number("highestSalePrice"),
                        price_count: sale_count,
                    },
                ))
            })
            .collect())
    }
}

/// Whether Node's price for the SKU read competing asks.
pub fn leaned_on_supply(details: &Value) -> bool {
    let observed = |v: &Value| v.get("supplyStatus").and_then(Value::as_str) == Some("observed");
    observed(&details["decision"])
        || details["percentiles"]
            .as_array()
            .is_some_and(|points| points.iter().any(observed))
}

/// How a SKU's result compares.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum Verdict {
    Same,
    /// Node's price read competing asks, which the shadow cannot read; only the curve the sales
    /// alone draw is compared, and `curve` holds where it differs.
    SupplyDependent {
        curve: Vec<Field>,
    },
    /// Node could not reach TCGplayer for the SKU, so it has no price to compare.
    NodeUnreachable {
        error: String,
    },
    Different {
        fields: Vec<Field>,
    },
    /// Node saved a result the shadow did not produce, or the other way round.
    Missing {
        side: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Field {
    pub name: String,
    pub rust: Value,
    pub node: Value,
}

/// Whether an error is a failed connection rather than something about the SKU.
pub fn unreachable(error: &str) -> bool {
    [
        "socket",
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "timeout",
        "Request failed with status code 5",
        "Request failed with status code 429",
        "Request failed with status code 403",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

/// Where the curves drawn from the same sales differ, point by point: the price at each
/// percentile to the cent, the days between buyers, the sales counted, and whether history was
/// capped.
pub fn curve_differences(ours: &Value, node: &Value) -> Vec<Field> {
    let empty = Vec::new();
    let ours = ours["percentiles"].as_array().unwrap_or(&empty);
    let theirs = node["percentiles"].as_array().unwrap_or(&empty);
    let mut fields = Vec::new();
    if ours.len() != theirs.len() {
        fields.push(Field {
            name: "percentiles".into(),
            rust: ours.len().into(),
            node: theirs.len().into(),
        });
        return fields;
    }
    let cents = |v: &Value| v.as_f64().map(|p| (p * 100.0).round() as i64);
    let close = |a: &Value, b: &Value| match (a.as_f64(), b.as_f64()) {
        (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0),
        _ => a == b,
    };
    for (r, n) in ours.iter().zip(theirs) {
        let at = r["percentile"].clone();
        let mut differs = |key: &str, same: bool| {
            if !same {
                fields.push(Field {
                    name: format!("percentiles[{at}].{key}"),
                    rust: r[key].clone(),
                    node: n[key].clone(),
                });
            }
        };
        differs(
            "suggestedPrice",
            cents(&r["suggestedPrice"]) == cents(&n["suggestedPrice"]),
        );
        differs(
            "historicalSalesVelocityDays",
            close(
                &r["historicalSalesVelocityDays"],
                &n["historicalSalesVelocityDays"],
            ),
        );
        differs("salesCount", close(&r["salesCount"], &n["salesCount"]));
        differs("historyCapped", r["historyCapped"] == n["historyCapped"]);
    }
    fields
}

/// The fields a cutover depends on: the status, the listed and suggested prices to the cent, the
/// percentile, the method, and every error and warning.
pub fn compare(rust: &PricedSku, node: &Saved) -> Verdict {
    let Some(details) = &node.pricing_details_json else {
        return Verdict::Missing {
            side: "node details",
        };
    };
    let ours = results::details(
        rust,
        Mode::Full,
        DateTime::UNIX_EPOCH,
        &StoredConfig::default(),
    );
    let node_error = node.row_json["Error"].as_str().unwrap_or_default();
    if details.get("decision").is_none() && unreachable(node_error) {
        return Verdict::NodeUnreachable {
            error: node_error.into(),
        };
    }
    if leaned_on_supply(details) {
        return Verdict::SupplyDependent {
            curve: curve_differences(&ours, details),
        };
    }
    let row = results::row(rust);
    let cents = |v: &Value| v.as_f64().map(|p| (p * 100.0).round() as i64);
    let mut fields = Vec::new();
    let mut check = |name: &str, r: Value, n: Value| {
        if r != n {
            fields.push(Field {
                name: name.into(),
                rust: r,
                node: n,
            });
        }
    };
    check(
        "resultStatus",
        results::status(rust).into(),
        node.result_status.clone().into(),
    );
    for (name, key) in [
        ("marketplacePrice", "marketplacePrice"),
        ("suggestedPrice", "suggestedPrice"),
    ] {
        check(name, cents(&ours[key]).into(), cents(&details[key]).into());
    }
    let percentile = |v: &Value| v.as_f64().map(|p| p.to_string());
    check(
        "percentileUsed",
        percentile(&ours["percentileUsed"]).into(),
        percentile(&details["percentileUsed"]).into(),
    );
    check(
        "method",
        ours["decision"]["method"].clone(),
        details["decision"]["method"].clone(),
    );
    check(
        "errors",
        row["Error"].clone(),
        node.row_json["Error"].clone(),
    );
    check(
        "warnings",
        row["Warning"].clone(),
        node.row_json["Warning"].clone(),
    );
    if fields.is_empty() {
        Verdict::Same
    } else {
        Verdict::Different { fields }
    }
}

/// One job's comparison.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Tally {
    pub same: usize,
    pub supply_dependent: usize,
    /// Of the supply-dependent, those whose curve from sales matches Node's.
    pub same_curve: usize,
    pub node_unreachable: usize,
    pub different: usize,
    pub missing: usize,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Line<'a> {
    Sku {
        at: &'a str,
        job: i64,
        batch: i32,
        sku: i32,
        #[serde(flatten)]
        verdict: &'a Verdict,
    },
    Job {
        at: &'a str,
        job: i64,
        batch: i32,
        mode: &'a str,
        error: Option<&'a str>,
        #[serde(flatten)]
        tally: &'a Tally,
    },
}

/// Prices `job`'s batch again and compares each SKU with Node's result.
pub async fn replay(db: &Database, job: &Finished) -> Result<(Tally, Vec<(i32, Verdict)>), String> {
    let mode = Mode::of(&job.mode).ok_or_else(|| format!("unknown mode {}", job.mode))?;
    let batch: Batch = job::batch(db, job.batch_number).await?;
    let node = saved(db, job.batch_number).await?;
    let ledgers = Ledgers {
        db,
        as_of: job.completed_at,
    };
    let priced = job::price(
        db,
        &batch,
        mode,
        &job.config_json,
        &ledgers,
        &SavedMarket(&node),
        job.started_at,
        &mut |_| {},
    )
    .await
    .map_err(|stopped| stopped.to_string())?;
    let ours: HashMap<i32, &PricedSku> =
        priced.skus.iter().map(|s| (s.item.sku as i32, s)).collect();
    let mut tally = Tally::default();
    let mut verdicts = Vec::new();
    for saved in &node {
        let verdict = match ours.get(&saved.sku) {
            Some(rust) => compare(rust, saved),
            None => Verdict::Missing { side: "rust" },
        };
        let quiet = match &verdict {
            Verdict::Same => {
                tally.same += 1;
                true
            }
            Verdict::SupplyDependent { curve } => {
                tally.supply_dependent += 1;
                tally.same_curve += usize::from(curve.is_empty());
                curve.is_empty()
            }
            Verdict::NodeUnreachable { .. } => {
                tally.node_unreachable += 1;
                false
            }
            Verdict::Different { .. } => {
                tally.different += 1;
                false
            }
            Verdict::Missing { .. } => {
                tally.missing += 1;
                false
            }
        };
        if !quiet {
            verdicts.push((saved.sku, verdict));
        }
    }
    let saved_skus: std::collections::HashSet<i32> = node.iter().map(|s| s.sku).collect();
    for sku in ours.keys().filter(|s| !saved_skus.contains(s)) {
        tally.missing += 1;
        verdicts.push((*sku, Verdict::Missing { side: "node" }));
    }
    Ok((tally, verdicts))
}

async fn finished_after(db: &Database, after: i64) -> Result<Vec<Finished>, String> {
    sqlx::query_as(
        "SELECT id, batch_number, mode, config_json, started_at, completed_at
         FROM inventory_batch_pricing_jobs
         WHERE status = 'completed' AND id > $1 AND mode IN ('full', 'errors')
           AND started_at IS NOT NULL AND completed_at IS NOT NULL
         ORDER BY id",
    )
    .bind(after)
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())
}

async fn latest_id(db: &Database) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM inventory_batch_pricing_jobs")
        .fetch_one(&db.0)
        .await
        .map_err(|e| e.to_string())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Replays `job` and appends its lines to `log`.
pub async fn log_replay(db: &Database, job: &Finished, log: &PathBuf) -> Result<Tally, String> {
    let replayed = replay(db, job).await;
    let at = now();
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| format!("the shadow log did not open: {e}"))?;
    let mut write = |line: &Line| -> Result<(), String> {
        let text = serde_json::to_string(line).map_err(|e| e.to_string())?;
        writeln!(file, "{text}").map_err(|e| e.to_string())
    };
    let (tally, error) = match &replayed {
        Ok((tally, verdicts)) => {
            for (sku, verdict) in verdicts {
                write(&Line::Sku {
                    at: &at,
                    job: job.id,
                    batch: job.batch_number,
                    sku: *sku,
                    verdict,
                })?;
            }
            (tally, None)
        }
        Err(why) => (&Tally::default(), Some(why.as_str())),
    };
    write(&Line::Job {
        at: &at,
        job: job.id,
        batch: job.batch_number,
        mode: &job.mode,
        error,
        tally,
    })?;
    replayed.map(|(tally, _)| tally)
}

/// The task: when `BATCH_PRICING_SHADOW_LOG` names a log, each job Node finishes from now on is
/// replayed and compared, until shutdown.
pub async fn run(db: Database, signal: Signal) {
    let Some(log) = log_path() else {
        return;
    };
    println!("Batch pricing shadow: logging to {}", log.display());
    let mut after = match latest_id(&db).await {
        Ok(id) => id,
        Err(why) => {
            eprintln!("Batch pricing shadow could not start: {why}");
            return;
        }
    };
    let mut every = interval(EVERY);
    every.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = every.tick() => {}
        }
        let jobs = match finished_after(&db, after).await {
            Ok(jobs) => jobs,
            Err(why) => {
                eprintln!("Batch pricing shadow: finished jobs could not be read: {why}");
                continue;
            }
        };
        for job in jobs {
            after = job.id;
            if let Err(why) = log_replay(&db, &job, &log).await {
                eprintln!("Batch pricing shadow: job {} failed: {why}", job.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_price_that_read_competing_asks_leaned_on_supply() {
        assert!(leaned_on_supply(
            &json!({ "decision": { "supplyStatus": "observed" } })
        ));
        assert!(leaned_on_supply(
            &json!({ "percentiles": [{ "supplyStatus": "observed" }] })
        ));
        assert!(!leaned_on_supply(
            &json!({ "decision": { "supplyStatus": "unavailable" } })
        ));
        assert!(!leaned_on_supply(&json!({})));
    }

    #[test]
    fn a_failed_connection_is_not_about_the_sku() {
        assert!(unreachable(
            "Client network socket disconnected before secure TLS connection was established"
        ));
        assert!(unreachable("Request failed with status code 503"));
        assert!(!unreachable("Request failed with status code 404"));
        assert!(!unreachable(
            "No category filter found for categoryId (productLineId) 3"
        ));
    }

    #[test]
    fn curves_compare_prices_to_the_cent_and_counts_exactly() {
        let point = |price: f64, days: f64| {
            json!({ "percentile": 65, "suggestedPrice": price, "historicalSalesVelocityDays": days,
                    "salesCount": 3, "historyCapped": false })
        };
        let node = json!({ "percentiles": [point(1.234, 18.25)] });
        assert!(
            curve_differences(&json!({ "percentiles": [point(1.2349, 18.25)] }), &node).is_empty()
        );
        let moved = curve_differences(&json!({ "percentiles": [point(1.25, 18.5)] }), &node);
        let names: Vec<&str> = moved.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "percentiles[65].suggestedPrice",
                "percentiles[65].historicalSalesVelocityDays"
            ]
        );
        assert_eq!(
            curve_differences(&json!({ "percentiles": [] }), &node)[0].name,
            "percentiles"
        );
    }

    /// Replays Node's finished jobs from `BATCH_PRICING_SHADOW_FROM` (a job id; the job after
    /// it is the first) for `BATCH_PRICING_SHADOW_JOBS` jobs (default 10), logged to
    /// `BATCH_PRICING_SHADOW_LOG`. Reads the dev database only.
    #[tokio::test]
    #[ignore = "reads the dev database's finished pricing jobs and ledgers"]
    async fn replays_finished_jobs() {
        crate::config::load_env();
        let log = log_path().expect("BATCH_PRICING_SHADOW_LOG names the log");
        let from: i64 = std::env::var("BATCH_PRICING_SHADOW_FROM")
            .expect("BATCH_PRICING_SHADOW_FROM names a job id")
            .parse()
            .unwrap();
        let count: usize = std::env::var("BATCH_PRICING_SHADOW_JOBS")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(10);
        let db = Database::connect_lazy(&crate::config::database_url());
        let jobs = finished_after(&db, from).await.unwrap();
        let mut total = Tally::default();
        for job in jobs.iter().take(count) {
            match log_replay(&db, job, &log).await {
                Ok(tally) => {
                    println!("job {} batch {}: {tally:?}", job.id, job.batch_number);
                    total.same += tally.same;
                    total.supply_dependent += tally.supply_dependent;
                    total.same_curve += tally.same_curve;
                    total.node_unreachable += tally.node_unreachable;
                    total.different += tally.different;
                    total.missing += tally.missing;
                }
                Err(why) => println!("job {} batch {}: failed: {why}", job.id, job.batch_number),
            }
        }
        println!("total: {total:?}");
    }
}
