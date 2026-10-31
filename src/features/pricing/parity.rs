//! Parity with the Node pricer on identical evidence: `.port-logs/pricing-parity.ts` prices dev
//! SKUs from the ledgers through Node's resolver and calculator and writes the evidence it served
//! with its answers; this prices the same SKUs from the same evidence and compares every value.
use std::{cell::RefCell, collections::HashMap};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::calculator::{self, Aggregated, PricerSku};
use super::policy::SupplyStatus;
use super::resolver::LatestSales;
use super::sale::Sale;
use super::sku_price::{Evidence, Failure, History, HistoryBucket, Sku};
use super::supply_analysis::{Listing, Observation as Supply};
use crate::{
    database::Database,
    features::{configuration::config, shipping_thresholds::evidence},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureSku {
    sku: i64,
    product_line_id: i64,
    quantity: Option<f64>,
    add_to_quantity: Option<f64>,
    current_price: Option<f64>,
    bypass_product_line_skips: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    market_price: String,
    transaction_count: String,
    bucket_start_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    sku_id: String,
    condition: String,
    variant: String,
    language: String,
    buckets: Vec<Bucket>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ask {
    condition: String,
    price: f64,
    shipping_cost: f64,
    seller_id: String,
    seller_key: String,
    listing_id: i64,
}

#[derive(Deserialize)]
struct Run {
    name: String,
    result: Value,
    ceilings: HashMap<String, Option<f64>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    now: String,
    seller: String,
    skus: Vec<FixtureSku>,
    market_prices: HashMap<String, f64>,
    sales: HashMap<String, Vec<Sale>>,
    history: HashMap<String, Vec<HistoryEntry>>,
    listings: HashMap<String, Vec<Ask>>,
    cost_model: Value,
    runs: Vec<Run>,
}

/// The evidence Node was served, and the listing ceilings asked for.
struct Recorded<'a> {
    fixture: &'a Fixture,
    ceilings: RefCell<HashMap<String, Option<f64>>>,
}

fn key(sku: &Sku) -> String {
    format!("{}|{}|{}", sku.product_id, sku.variant, sku.language)
}

/// JavaScript's `Number(text)` for the history's numeric strings.
fn number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        0.0
    } else {
        text.parse().unwrap_or(f64::NAN)
    }
}

impl Recorded<'_> {
    fn asks(&self, sku: &Sku, excluded: Option<&str>) -> Vec<Listing> {
        self.fixture
            .listings
            .get(&key(sku))
            .into_iter()
            .flatten()
            .filter(|ask| Some(ask.seller_key.as_str()) != excluded)
            .map(|ask| Listing {
                condition: ask.condition.clone(),
                price: ask.price,
                shipping_cost: ask.shipping_cost,
                seller_id: ask.seller_id.clone(),
                seller_key: ask.seller_key.clone(),
                listing_id: ask.listing_id,
            })
            .collect()
    }
}

impl Evidence for Recorded<'_> {
    async fn latest_sales(&self, sku: &Sku) -> Result<Vec<Sale>, Failure> {
        Ok(self
            .fixture
            .sales
            .get(&key(sku))
            .cloned()
            .unwrap_or_default())
    }

    async fn price_history(&self, product_id: i64) -> Option<Vec<History>> {
        let entries = self
            .fixture
            .history
            .get(&product_id.to_string())
            .filter(|e| !e.is_empty())?;
        Some(
            entries
                .iter()
                .map(|entry| History {
                    sku_id: number(&entry.sku_id) as i64,
                    condition: entry.condition.clone(),
                    variant: entry.variant.clone(),
                    language: entry.language.clone(),
                    buckets: entry
                        .buckets
                        .iter()
                        .map(|b| HistoryBucket {
                            market_price: number(&b.market_price),
                            transaction_count: number(&b.transaction_count),
                            bucket_start_date: b.bucket_start_date.clone(),
                        })
                        .collect(),
                })
                .collect(),
        )
    }

    async fn listings(&self, sku: &Sku, ceiling: Option<f64>, excluded: Option<&str>) -> Supply {
        self.ceilings
            .borrow_mut()
            .insert(sku.sku.to_string(), ceiling);
        Supply {
            status: SupplyStatus::Observed,
            listings: self
                .asks(sku, excluded)
                .into_iter()
                .filter(|l| ceiling.is_none_or(|c| l.delivered() <= c))
                .collect(),
        }
    }

    async fn lowest_listing_price(&self, sku: &Sku, excluded: Option<&str>) -> Option<f64> {
        self.asks(sku, excluded)
            .into_iter()
            .find(|l| l.condition == sku.condition)
            .map(|l| l.delivered())
    }
}

#[derive(Default)]
struct Diff {
    exact: usize,
    /// Numbers apart by no more than a few units in the last place.
    near: usize,
    near_fields: Vec<(String, usize, String)>,
    differences: Vec<String>,
}

/// A path without its array indexes.
fn field_of(path: &str) -> String {
    path.split('[')
        .map(|part| part.split_once(']').map_or(part, |(_, rest)| rest))
        .collect::<Vec<_>>()
        .join("[]")
}

impl Diff {
    fn compare(&mut self, path: &str, rust: &Value, node: &Value) {
        match (rust, node) {
            (Value::Number(r), Value::Number(n)) => {
                let (r, n) = (r.as_f64().unwrap(), n.as_f64().unwrap());
                if r == n {
                    self.exact += 1;
                } else if (r - n).abs() <= 1e-9 * r.abs().max(n.abs()).max(1.0) {
                    self.near += 1;
                    let field = field_of(path);
                    match self.near_fields.iter_mut().find(|(f, _, _)| *f == field) {
                        Some((_, count, _)) => *count += 1,
                        None => self.near_fields.push((
                            field,
                            1,
                            format!("{path}: rust {r:?} node {n:?}"),
                        )),
                    }
                } else {
                    self.differences.push(format!("{path}: rust {r} node {n}"));
                }
            }
            (Value::Object(r), Value::Object(n)) => {
                for (k, v) in r {
                    match n.get(k) {
                        Some(nv) => self.compare(&format!("{path}.{k}"), v, nv),
                        None => self
                            .differences
                            .push(format!("{path}.{k}: rust {v} node absent")),
                    }
                }
                for (k, v) in n {
                    if !r.contains_key(k) {
                        self.differences
                            .push(format!("{path}.{k}: rust absent node {v}"));
                    }
                }
            }
            (Value::Array(r), Value::Array(n)) if r.len() == n.len() => {
                for (i, (rv, nv)) in r.iter().zip(n).enumerate() {
                    self.compare(&format!("{path}[{i}]"), rv, nv);
                }
            }
            _ if rust == node => self.exact += 1,
            _ => self
                .differences
                .push(format!("{path}: rust {rust} node {node}")),
        }
    }
}

fn aggregated(a: &Aggregated) -> Value {
    let object = |entries: &[(String, f64)]| {
        Value::Object(entries.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
    };
    json!({
        "marketPrice": object(&a.market_price),
        "historicalSalesVelocity": object(&a.historical_sales_velocity),
        "estimatedTimeToSell": object(&a.estimated_time_to_sell),
    })
}

#[tokio::test]
#[ignore = "reads the dev database and a file the Node app wrote"]
async fn prices_match_node_on_the_same_evidence() {
    crate::config::load_env();
    let path = std::env::var("PRICING_PARITY").expect("PRICING_PARITY names Node's answers");
    let fixture: Fixture = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let now: DateTime<Utc> = fixture.now.parse().unwrap();
    let db = Database::connect_lazy(&crate::config::database_url());
    let stored = config::load(&db).await.unwrap();
    let model = evidence::learn_recent(
        &db,
        &fixture.seller,
        stored.snaps.evidence_window_days.into(),
        now,
    )
    .await
    .unwrap();

    let mut diff = Diff::default();
    diff.compare(
        "costModel",
        &serde_json::to_value(&model).unwrap(),
        &fixture.cost_model,
    );
    let skus: Vec<PricerSku> = fixture
        .skus
        .iter()
        .map(|s| PricerSku {
            sku: s.sku,
            quantity: s.quantity,
            add_to_quantity: s.add_to_quantity,
            current_price: s.current_price,
            product_line_id: s.product_line_id,
            bypass_product_line_skips: s.bypass_product_line_skips,
        })
        .collect();
    let market: HashMap<i64, f64> = fixture
        .market_prices
        .iter()
        .map(|(k, v)| (k.parse().unwrap(), *v))
        .collect();
    let seller = Some(fixture.seller.clone());
    for run in &fixture.runs {
        let mut config = match run.name.as_str() {
            "profit-per-day-snaps" => {
                calculator::config_of(&stored, seller.clone(), Some(model.clone()))
            }
            _ => calculator::config_of(&stored, seller.clone(), None),
        };
        if run.name == "percentile" {
            config.policy = None;
        }
        let recorded = Recorded {
            fixture: &fixture,
            ceilings: RefCell::default(),
        };
        let resolver = LatestSales {
            db: &db,
            evidence: &recorded,
            now: now.timestamp_millis() as f64,
        };
        let result = calculator::calculate(&skus, &config, &market, "parity", &resolver, now)
            .await
            .unwrap();
        let name = &run.name;
        diff.compare(
            &format!("{name}.pricedItems"),
            &serde_json::to_value(&result.priced_items).unwrap(),
            &run.result["pricedItems"],
        );
        diff.compare(
            &format!("{name}.shadowPortfolioPlan"),
            &serde_json::to_value(&result.shadow_portfolio_plan).unwrap(),
            run.result
                .get("shadowPortfolioPlan")
                .unwrap_or(&Value::Null),
        );
        let stats = result.stats;
        diff.compare(
            &format!("{name}.stats"),
            &json!({ "processed": stats.processed, "skipped": stats.skipped, "errors": stats.errors, "warnings": stats.warnings, "processingTime": 0 }),
            &run.result["stats"],
        );
        diff.compare(
            &format!("{name}.aggregatedPercentiles"),
            &aggregated(&result.aggregated_percentiles),
            &run.result["aggregatedPercentiles"],
        );
        diff.compare(
            &format!("{name}.ceilings"),
            &serde_json::to_value(&*recorded.ceilings.borrow()).unwrap(),
            &serde_json::to_value(&run.ceilings).unwrap(),
        );
    }
    println!(
        "{} SKUs, {} runs: {} values exact, {} within 1e-9, {} different",
        skus.len(),
        fixture.runs.len(),
        diff.exact,
        diff.near,
        diff.differences.len()
    );
    // One example of each field that differs, its indexes dropped, with how often.
    let mut fields: Vec<(String, usize, &String)> = Vec::new();
    for difference in &diff.differences {
        let path = difference.split(':').next().unwrap_or_default();
        let field = field_of(path);
        match fields.iter_mut().find(|(f, _, _)| *f == field) {
            Some((_, count, _)) => *count += 1,
            None => fields.push((field, 1, difference)),
        }
    }
    for (field, count, example) in &diff.near_fields {
        println!("  near {count} x {field}\n      {example}");
    }
    for (field, count, example) in &fields {
        println!("  {count} x {field}\n      {example}");
    }
    assert!(diff.differences.is_empty());
}
