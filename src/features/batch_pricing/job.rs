//! Pricing one inventory batch (`executeInventoryBatchPricingJob`): its items, their catalog names,
//! the market data for them, the calculator over the latest-sales resolver, and the summary.
use std::{collections::HashMap, time::Instant};

use chrono::{DateTime, Utc};

use super::{cache::Cached, results::summary};
use crate::{
    database::Database,
    features::{
        configuration::config::{Config as StoredConfig, Policy as StoredPolicy},
        pricing::{
            calculator::{self, Calculation, PricedItem, PricerSku, Stats, Stopped, Tick},
            resolver::LatestSales,
            sku_price::Evidence,
        },
        shipping_configuration,
        shipping_thresholds::evidence::learn_recent,
    },
};

/// What a job prices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Every item.
    Full,
    /// Only the items whose last result needs manual review.
    Errors,
    /// Every item from its saved curve, without new evidence (continuous batches).
    Cached,
}

impl Mode {
    pub fn of(text: &str) -> Option<Mode> {
        match text {
            "full" => Some(Mode::Full),
            "errors" => Some(Mode::Errors),
            "cached" => Some(Mode::Cached),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Full => "full",
            Mode::Errors => "errors",
            Mode::Cached => "cached",
        }
    }
}

/// TCGplayer's market data for a SKU (`PricePoint`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PricePoint {
    pub market_price: f64,
    pub lowest_price: f64,
    pub highest_price: f64,
    pub price_count: f64,
}

/// Where a job reads its SKUs' market data.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait MarketData {
    async fn price_points(&self, skus: &[i64]) -> Result<HashMap<i64, PricePoint>, String>;
}

/// A SKU as the catalog names it (`ProductDisplayInfo`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Display {
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub variant: String,
}

/// A priced SKU with its name and market data (`PricedSku`).
#[derive(Clone, Debug, PartialEq)]
pub struct PricedSku {
    pub item: PricedItem,
    pub display: Option<Display>,
    pub point: Option<PricePoint>,
}

/// A priced batch: its SKUs in the order they were priced, its summary document, and the
/// progress it ended at.
#[derive(Debug)]
pub struct Priced {
    pub skus: Vec<PricedSku>,
    pub summary: serde_json::Value,
    pub progress: serde_json::Value,
}

/// A step of a job as the Batch Pricer's progress panel reads it (`ProcessingProgress`): one of
/// six, its phase and when it began, the counts so far, and how far within the step.
fn step(
    current: u32,
    status: &str,
    phase: &str,
    phase_start: Option<i64>,
    counts: Stats,
    within: Option<(usize, usize, &str)>,
) -> serde_json::Value {
    let mut step = serde_json::json!({
        "current": current,
        "total": 6,
        "status": status,
        "processed": counts.processed,
        "skipped": counts.skipped,
        "errors": counts.errors,
        "warnings": counts.warnings,
        "phase": phase,
    });
    if let Some(at) = phase_start {
        step["phaseStartTime"] = at.into();
    }
    if let Some((current, total, status)) = within {
        step["subProgress"] =
            serde_json::json!({ "current": current, "total": total, "status": status });
    }
    step
}

/// Wall-clock milliseconds, as `Date.now()` stamps a phase.
fn wall_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// The batch a job prices.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Batch {
    pub batch_number: i32,
    pub source_type: String,
    pub source_label: String,
}

#[derive(sqlx::FromRow)]
struct Item {
    sku: i32,
    total_quantity: i32,
    add_to_quantity: i32,
    current_price: Option<f64>,
    product_line_id: i32,
    product_id: i32,
}

#[derive(sqlx::FromRow)]
struct Named {
    sku: i32,
    product_line_id: i32,
    product_line_name: Option<String>,
    set_name: Option<String>,
    product_name: Option<String>,
    rarity_name: Option<String>,
    condition: String,
    variant: String,
    language: String,
}

/// `createDisplayName`: the name, the card number when the name lacks it, the rarity, and the
/// language unless English.
pub fn display_name(
    name: &str,
    number: Option<&str>,
    rarity: Option<&str>,
    language: &str,
) -> String {
    let mut parts = vec![name];
    if let Some(number) = number.filter(|n| !n.is_empty() && !name.contains(n)) {
        parts.push(number);
    }
    if let Some(rarity) = rarity.filter(|r| !r.is_empty()) {
        parts.push(rarity);
    }
    if !language.is_empty() && language != "English" {
        parts.push(language);
    }
    parts.join(" - ")
}

fn failed(error: sqlx::Error) -> String {
    error.to_string()
}

pub async fn batch(db: &Database, batch_number: i32) -> Result<Batch, String> {
    sqlx::query_as(
        "SELECT batch_number, source_type, source_label FROM inventory_batches WHERE batch_number = $1",
    )
    .bind(batch_number)
    .fetch_optional(&db.0)
    .await
    .map_err(failed)?
    .ok_or_else(|| format!("Batch {batch_number} not found"))
}

async fn items(db: &Database, batch_number: i32, mode: Mode) -> Result<Vec<Item>, String> {
    let errors_only = if mode == Mode::Errors {
        "AND i.sku > 0
         AND (i.total_quantity > 0 OR i.add_to_quantity > 0)
         AND EXISTS (SELECT 1 FROM inventory_batch_results r
                     WHERE r.batch_number = i.batch_number AND r.sku = i.sku
                       AND r.result_status <> 'successful')"
    } else {
        ""
    };
    sqlx::query_as(&format!(
        "SELECT i.sku, i.total_quantity, i.add_to_quantity, i.current_price::float8 AS current_price,
                i.product_line_id, i.product_id
         FROM inventory_batch_items i
         WHERE i.batch_number = $1 {errors_only}
         ORDER BY i.created_at, i.sku"
    ))
    .bind(batch_number)
    .fetch_all(&db.0)
    .await
    .map_err(failed)
}

/// Each item's name as the catalog has it, by SKU (`loadProductDisplayMap`).
async fn names(db: &Database, items: &[Item]) -> Result<HashMap<i64, Display>, String> {
    let skus: Vec<i32> = items.iter().map(|i| i.sku).collect();
    let products: Vec<i32> = items.iter().map(|i| i.product_id).collect();
    let rows: Vec<Named> = sqlx::query_as(
        "SELECT sku, product_line_id, product_line_name, set_name, product_name, rarity_name,
                condition, variant, language
         FROM skus WHERE sku = ANY($1)",
    )
    .bind(&skus)
    .fetch_all(&db.0)
    .await
    .map_err(failed)?;
    let numbers: HashMap<i32, String> =
        sqlx::query_as("SELECT product_id, number FROM set_products WHERE product_id = ANY($1)")
            .bind(&products)
            .fetch_all(&db.0)
            .await
            .map_err(failed)?
            .into_iter()
            .collect();
    // Node looks each SKU up within its item's product line and numbers it by its item's product.
    let item_of: HashMap<i32, &Item> = items.iter().map(|i| (i.sku, i)).collect();
    let mut shown = HashMap::new();
    for row in rows {
        let Some(item) = item_of
            .get(&row.sku)
            .filter(|i| i.product_line_id == row.product_line_id)
        else {
            continue;
        };
        let number = numbers.get(&item.product_id);
        shown.insert(
            i64::from(row.sku),
            Display {
                product_line: row.product_line_name.unwrap_or_default(),
                set_name: row.set_name.unwrap_or_default(),
                product_name: display_name(
                    row.product_name.as_deref().unwrap_or_default(),
                    number.map(String::as_str),
                    row.rarity_name.as_deref(),
                    &row.language,
                ),
                condition: row.condition,
                variant: row.variant,
            },
        );
    }
    Ok(shown)
}

/// The shipping cost model snaps are priced with, when the policy snaps; none when it cannot be
/// learned, as Node prices without snaps then.
async fn cost_model(
    db: &Database,
    stored: &StoredConfig,
    now: DateTime<Utc>,
) -> Option<crate::features::shipping_thresholds::ShippingCostModel> {
    let snaps = &stored.snaps;
    if !matches!(stored.pricing.policy, StoredPolicy::ProfitPerDay)
        || !snaps.enabled
        || snaps.thresholds.is_empty()
    {
        return None;
    }
    let seller = shipping_configuration::default_seller_key(db).await.ok()?;
    let seller = seller.trim();
    if seller.is_empty() {
        return None;
    }
    learn_recent(db, seller, snaps.evidence_window_days.into(), now)
        .await
        .inspect_err(|e| {
            eprintln!(
                "Shipping cost model could not be learned; pricing without threshold snaps. {e}"
            )
        })
        .ok()
}

/// Prices `batch`'s items under `stored` as of `now`, reading sales through `evidence` and
/// market data through `market`, each step told to `report` as Node's worker reports it.
/// Saved-curve repricing (`cached`) is not ported yet.
#[allow(
    clippy::too_many_arguments,
    reason = "executeInventoryBatchPricingJob's inputs"
)]
pub async fn price<E: Evidence, M: MarketData>(
    db: &Database,
    batch: &Batch,
    mode: Mode,
    stored: &StoredConfig,
    evidence: &E,
    market: &M,
    now: DateTime<Utc>,
    report: &mut impl FnMut(serde_json::Value),
) -> Result<Priced, Stopped> {
    let started = Instant::now();
    let none = Stats::default();
    report(step(
        1,
        "Loading inventory batch items...",
        "Data Validation",
        Some(wall_ms()),
        none,
        None,
    ));
    let items = items(db, batch.batch_number, mode).await?;
    let bypass = matches!(batch.source_type.as_str(), "pending_inventory" | "strategy");
    let sources: Vec<PricerSku> = items
        .iter()
        .filter(|i| i.sku > 0 && i.total_quantity + i.add_to_quantity > 0)
        .map(|i| PricerSku {
            sku: i.sku.into(),
            quantity: (i.total_quantity > 0).then_some(f64::from(i.total_quantity)),
            add_to_quantity: (i.add_to_quantity > 0).then_some(f64::from(i.add_to_quantity)),
            current_price: i.current_price,
            product_line_id: i.product_line_id.into(),
            bypass_product_line_skips: bypass,
        })
        .collect();
    if sources.is_empty() {
        return Err(if mode == Mode::Errors {
            "No manual review rows are available to reprice".into()
        } else {
            "No batch items are available to price".into()
        });
    }
    let names = names(db, &items).await?;
    if mode == Mode::Cached {
        if batch.source_type != "continuous" {
            return Err("Saved-curve repricing requires a continuous inventory batch.".into());
        }
        return Err("Saved-curve repricing is not ported yet.".into());
    }
    let invalid = items.len() - sources.len();
    let skipped = Stats {
        skipped: invalid,
        ..none
    };
    let n = sources.len();
    report(step(
        2,
        &format!("Validated {n} SKUs, preparing price data..."),
        "Preparing Price Data",
        Some(wall_ms()),
        skipped,
        None,
    ));
    let fetching = wall_ms();
    report(step(
        3,
        "Fetching price points...",
        "Fetching Price Data",
        Some(fetching),
        skipped,
        Some((0, n, "Requesting latest price points...")),
    ));
    let skus: Vec<i64> = sources.iter().map(|s| s.sku).collect();
    let points = market.price_points(&skus).await?;
    report(step(
        3,
        "Price points fetched successfully!",
        "Fetching Price Data",
        Some(fetching),
        skipped,
        Some((n, n, "Price data ready")),
    ));
    let market_prices: HashMap<i64, f64> = points
        .iter()
        .map(|(sku, p)| (*sku, p.market_price))
        .collect();

    let excluded = matches!(
        batch.source_type.as_str(),
        "seller" | "continuous" | "strategy"
    )
    .then(|| batch.source_label.clone());
    let config = calculator::config_of(stored, excluded, cost_model(db, stored, now).await);
    let cached = Cached::new(evidence);
    let resolver = LatestSales {
        db,
        evidence: &cached,
        now: now.timestamp_millis() as f64,
    };
    let source = format!("inventory-batch-{}", batch.batch_number);
    let pricing = wall_ms();
    report(step(
        4,
        "Calculating pricing...",
        "Calculating Prices",
        Some(pricing),
        skipped,
        None,
    ));
    let mut tick = |t: Tick| {
        let status = match t.sku {
            None if t.current == 0 => format!("Starting to process {} SKUs...", t.total),
            None => "Pricing calculation complete!".to_owned(),
            Some(sku) => {
                let name = names.get(&sku).map_or_else(
                    || format!("SKU {sku}"),
                    |d| format!("{} ({sku})", d.product_name),
                );
                format!("Processing {}/{}: {name}...", t.current, t.total)
            }
        };
        let counts = Stats {
            skipped: invalid + t.stats.skipped,
            ..t.stats
        };
        report(step(
            4,
            "Calculating pricing...",
            "Calculating Prices",
            Some(pricing),
            counts,
            Some((t.current, t.total, &status)),
        ));
    };
    let calculation: Calculation = calculator::calculate(
        &sources,
        &config,
        &market_prices,
        &source,
        &resolver,
        now,
        &mut tick,
    )
    .await?;
    let counts = Stats {
        skipped: invalid + calculation.stats.skipped,
        ..calculation.stats
    };
    report(step(
        5,
        "Enriching pricing data for display...",
        "Enriching Display Data",
        Some(wall_ms()),
        counts,
        None,
    ));
    let skus: Vec<PricedSku> = calculation
        .priced_items
        .iter()
        .map(|item| PricedSku {
            item: item.clone(),
            display: names.get(&item.sku).cloned(),
            point: points.get(&item.sku).copied(),
        })
        .collect();
    let summary = summary(
        batch.batch_number,
        &sources,
        invalid,
        &calculation,
        &skus,
        &names,
        stored,
        started.elapsed().as_millis(),
    );
    let progress = step(6, "Complete", "Complete", None, counts, None);
    report(progress.clone());
    Ok(Priced {
        skus,
        summary,
        progress,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_as_the_node_app_writes_them() {
        assert_eq!(
            display_name("Pikachu", Some("025/165"), Some("Common"), "Japanese"),
            "Pikachu - 025/165 - Common - Japanese"
        );
        assert_eq!(
            display_name("Pikachu 025/165", Some("025/165"), Some(""), "English"),
            "Pikachu 025/165"
        );
        assert_eq!(display_name("Booster Box", None, None, ""), "Booster Box");
    }

    #[test]
    fn modes_read_as_jobs_store_them() {
        for mode in [Mode::Full, Mode::Errors, Mode::Cached] {
            assert_eq!(Mode::of(mode.as_str()), Some(mode));
        }
        assert_eq!(Mode::of("other"), None);
    }
}
