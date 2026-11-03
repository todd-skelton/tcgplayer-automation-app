//! One product's prices by condition and variant (`createProductPriceMatrixAction`): TCGplayer's
//! market and sales, the store's listing, and, when asked, what the active pricing policy would
//! sell at, with the sell-at and market prices clamped so no condition sits above a better one
//! (`conditionLadder.ts`). The refund for a condition dispute is worked out here
//! (`estimateRefund`) and, as the operator changes it, in the browser.
use std::{cmp::Ordering, collections::HashMap};

use chrono::{SecondsFormat, Utc};
use serde::Deserialize;

use super::products::Product;
use crate::{
    database::Database,
    features::{
        batch_pricing::{
            cache::Cached,
            job::cost_model,
            market::{Answer, TcgPlayerMarket},
        },
        configuration::config::{self as pricing_config, Config as StoredConfig, Policy as Stored},
        continuous_pricing::store,
        inventory_economics::ledger::assumptions::js_round,
        inventory_strategy::collate,
        pricing::{
            calculator::{self, PricedItem, PricerSku},
            condition_normalization::{self, Diagnostics},
            policy,
            resolver::LatestSales,
            tcgplayer_evidence::TcgPlayerEvidence,
        },
    },
    tcgplayer::{Call, TcgPlayer},
};

/// The matrix's answer. Read from the Node app's JSON in the parity test.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    #[serde(default)]
    pub variants: Vec<String>,
    pub cells: Vec<Cell>,
    pub suggested_prices_included: bool,
    #[serde(default)]
    pub policy: Option<Policy>,
    #[serde(default)]
    pub listings_included: bool,
    pub priced_at: String,
}

/// The store's own listing of a SKU.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub price: Option<f64>,
    pub quantity: i64,
    pub in_stock: bool,
}

/// One SKU: a condition of a variant in a language.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub sku: i64,
    pub condition: String,
    pub variant: String,
    pub language: String,
    pub tcg_market_price: Option<f64>,
    pub lowest_sale_price: Option<f64>,
    pub highest_sale_price: Option<f64>,
    #[serde(default)]
    pub sale_count: u64,
    pub listing: Option<Listing>,
    /// What the store would list at: the active policy's price after the floor.
    pub sell_at_price: Option<f64>,
    /// The sell-at price clamped so no condition sits above a better one.
    pub ladder_price: Option<f64>,
    /// The market price clamped the same way.
    pub market_ladder_price: Option<f64>,
    #[serde(default)]
    pub above_better_condition: bool,
    pub estimated_time_to_sell_days: Option<f64>,
    pub pricing_decision: Option<Decision>,
    /// The percentile policy's decision beside the active one, when they differ.
    pub shadow_pricing_decision: Option<Decision>,
    pub condition_normalization: Option<Normalization>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl Cell {
    /// The price a buyer most likely paid: the in-stock listing, else the sell-at price, else
    /// market.
    pub fn likely_paid(&self) -> Option<f64> {
        self.listing
            .as_ref()
            .filter(|l| l.in_stock && l.quantity > 0)
            .and_then(|l| l.price)
            .or(self.sell_at_price)
            .or(self.tcg_market_price)
    }

    /// How long it is expected to take to sell at its sell-at price, when the curve modeled it.
    pub fn modeled_days(&self) -> Option<f64> {
        self.pricing_decision
            .as_ref()
            .filter(|d| d.basis == "modeled")
            .and(self.estimated_time_to_sell_days)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    Percentile,
    TargetHorizon,
    ProfitPerDay,
}

impl Method {
    /// The policy's name as a column heading.
    pub fn label(self) -> &'static str {
        match self {
            Method::Percentile => "Percentile policy",
            Method::TargetHorizon => "Target horizon",
            Method::ProfitPerDay => "Profit per day",
        }
    }
}

/// How a price was chosen.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub method: Method,
    pub selected_price: f64,
    pub equivalent_percentile: Option<f64>,
    pub configured_percentile: Option<f64>,
    pub target_horizon_days: Option<f64>,
    pub daily_return_hurdle: Option<f64>,
    #[serde(default)]
    pub unprofitable: bool,
    pub estimated_median_sell_days: Option<f64>,
    /// `none`, `floor` or `current-price`.
    pub constraint: String,
    /// `modeled`, or where the price came from when the curve did not model it.
    pub basis: String,
}

impl Decision {
    /// The rule it followed: "65th percentile", "7.5 days target", "0.50%/day hurdle".
    pub fn rule(&self) -> String {
        match self.method {
            Method::Percentile => match self.configured_percentile {
                Some(p) => format!("{} percentile", ordinal(p)),
                None => "Percentile".into(),
            },
            Method::TargetHorizon => format!("{} target", days(self.target_horizon_days)),
            Method::ProfitPerDay => {
                format!("{} hurdle", hurdle(self.daily_return_hurdle.unwrap_or(0.0)))
            }
        }
    }

    /// Where the price came from when it was not modeled: "market reference".
    pub fn basis(&self) -> String {
        self.basis.replace('-', " ")
    }

    pub fn modeled(&self) -> bool {
        self.basis == "modeled"
    }
}

/// The policy the sell-at prices came from.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Policy {
    Percentile,
    TargetHorizon { horizon_days: f64 },
    ProfitPerDay { daily_return_hurdle: f64 },
}

impl Policy {
    pub fn describe(&self) -> String {
        match self {
            Policy::Percentile => "Configured percentile per product line".into(),
            Policy::TargetHorizon { horizon_days } => {
                format!("Target horizon of {}", days(Some(*horizon_days)))
            }
            Policy::ProfitPerDay {
                daily_return_hurdle,
            } => format!(
                "Profit per day at a {} hurdle",
                hurdle(*daily_return_hurdle)
            ),
        }
    }
}

/// What stood in for a condition's own market data.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Normalization {
    pub method: String,
    pub anchor_condition: Option<String>,
}

/// "7.5 days", "120 days", or "N/A" without a value (`formatDays`).
pub fn days(days: Option<f64>) -> String {
    match days.filter(|d| d.is_finite()) {
        None => "N/A".into(),
        Some(d) if d >= 100.0 => format!("{} days", grouped(d.round() as i64)),
        Some(d) => {
            let tenths = (d * 10.0).round() / 10.0;
            if tenths.fract() == 0.0 {
                format!("{} days", tenths as i64)
            } else {
                format!("{tenths} days")
            }
        }
    }
}

/// `1234` as `1,234`, as `toLocaleString` writes it in English.
fn grouped(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

/// "0.50%/day".
fn hurdle(daily_return: f64) -> String {
    format!("{:.2}%/day", daily_return * 100.0)
}

/// "65th", "1st", "12th".
pub fn ordinal(percentile: f64) -> String {
    let n = percentile.round() as i64;
    let suffix = match (n % 100, n % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

/// The refund that leaves the buyer paying what the received condition would sell for, and
/// what they keep paying. Never negative; none without a positive price paid and price for the
/// received condition.
#[derive(Debug, PartialEq)]
pub struct Refund {
    pub refund: f64,
    pub net: f64,
}

fn cents(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

pub fn refund(paid: Option<f64>, received: Option<f64>) -> Option<Refund> {
    let positive = |v: Option<f64>| v.filter(|v| v.is_finite() && *v > 0.0);
    let (paid, received) = (positive(paid)?, positive(received)?);
    let refund = cents((paid - received).max(0.0));
    Some(Refund {
        refund,
        net: cents(paid - refund),
    })
}

impl From<&policy::Decision> for Decision {
    fn from(d: &policy::Decision) -> Self {
        Decision {
            method: match d.method {
                policy::Method::Percentile => Method::Percentile,
                policy::Method::TargetHorizon => Method::TargetHorizon,
                policy::Method::ProfitPerDay => Method::ProfitPerDay,
            },
            selected_price: d.selected_price,
            equivalent_percentile: d.equivalent_percentile,
            configured_percentile: d.configured_percentile,
            target_horizon_days: d.target_horizon_days,
            daily_return_hurdle: d.daily_return_hurdle,
            unprofitable: d.unprofitable.unwrap_or(false),
            estimated_median_sell_days: d.estimated_median_sell_days,
            constraint: match d.constraint {
                policy::Constraint::Unconstrained => "none",
                policy::Constraint::Floor => "floor",
                policy::Constraint::CurrentPrice => "current-price",
            }
            .to_owned(),
            basis: match d.basis {
                policy::Basis::Modeled => "modeled",
                policy::Basis::MarketReference => "market-reference",
                policy::Basis::ListingReference => "listing-reference",
                policy::Basis::MarketAndListingReference => "market-and-listing-reference",
                policy::Basis::CurrentPrice => "current-price",
                policy::Basis::LegacyUnknown => "legacy-unknown",
            }
            .to_owned(),
        }
    }
}

impl From<&Diagnostics> for Normalization {
    fn from(d: &Diagnostics) -> Self {
        Normalization {
            method: match d.method {
                condition_normalization::Method::TimeControlledZipf => "time-controlled-zipf",
                condition_normalization::Method::SiblingMarketRatio => "sibling-market-ratio",
                condition_normalization::Method::NeutralConditionFallback => {
                    "neutral-condition-fallback"
                }
            }
            .to_owned(),
            anchor_condition: d.anchor_condition.clone(),
        }
    }
}

impl Policy {
    /// The active policy as it applies to a product line, with the line's own hurdle for profit
    /// per day (`productLinePricingPolicy(activePricingPolicy(..))`).
    fn of(stored: &StoredConfig, product_line_id: i32) -> Policy {
        match stored.pricing.policy {
            Stored::Percentile => Policy::Percentile,
            Stored::TargetHorizon(horizon_days) => Policy::TargetHorizon { horizon_days },
            Stored::ProfitPerDay => Policy::ProfitPerDay {
                daily_return_hurdle: stored
                    .product_lines
                    .settings
                    .get(&product_line_id)
                    .and_then(|s| s.daily_return_hurdle)
                    .unwrap_or(stored.pricing.profit_per_day.daily_return_hurdle),
            },
        }
    }
}

/// The graded conditions, best first (`INVENTORY_CONDITION_ORDER`).
const GRADED: [&str; 5] = [
    "Near Mint",
    "Lightly Played",
    "Moderately Played",
    "Heavily Played",
    "Damaged",
];

/// The variants in the order the matrix shows them (`DISPLAY_VARIANT_ORDER`); others follow.
const VARIANTS: [&str; 7] = [
    "Normal",
    "Holofoil",
    "Reverse Holofoil",
    "Unlimited",
    "Unlimited Holofoil",
    "1st Edition",
    "1st Edition Holofoil",
];

fn graded_rank(condition: &str) -> Option<usize> {
    GRADED.iter().position(|c| *c == condition)
}

/// `getConditionSortRank`: the graded conditions, then Unopened, then the rest.
fn condition_rank(condition: &str) -> usize {
    graded_rank(condition).unwrap_or(match condition {
        "Unopened" => GRADED.len(),
        _ => usize::MAX,
    })
}

fn variant_rank(variant: &str) -> usize {
    VARIANTS
        .iter()
        .position(|v| *v == variant)
        .unwrap_or(usize::MAX)
}

/// A condition's price after the ladder: clamped to the better conditions' price, and whether its
/// own price sat above it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Step {
    price: Option<f64>,
    above_better_condition: bool,
}

/// `buildConditionLadder`: from the best graded condition down, a price above a better
/// condition's is clamped to it. Conditions outside the graded order keep their own price.
fn ladder<'a>(inputs: &[(&'a str, Option<f64>)]) -> HashMap<&'a str, Step> {
    let mut ordered = inputs.to_vec();
    // JavaScript ranks a condition outside the order -1, ahead of Near Mint.
    ordered.sort_by_key(|(condition, _)| graded_rank(condition).map_or(-1, |r| r as i64));
    let mut ceiling: Option<f64> = None;
    let mut steps = HashMap::new();
    for (condition, price) in ordered {
        let step = match price.filter(|p| p.is_finite() && *p > 0.0) {
            None => Step::default(),
            Some(price) => {
                let rounded = js_round(price * 100.0) as f64 / 100.0;
                if graded_rank(condition).is_none() {
                    Step {
                        price: Some(rounded),
                        above_better_condition: false,
                    }
                } else {
                    let above = ceiling.is_some_and(|c| rounded > c);
                    let clamped = if above { ceiling } else { Some(rounded) };
                    ceiling = clamped;
                    Step {
                        price: clamped,
                        above_better_condition: above,
                    }
                }
            }
        };
        steps.insert(condition, step);
    }
    steps
}

/// `ladderCells` then `sortCells`: each variant's conditions in a language laddered, by sell-at
/// and by market price, then the cells by variant, condition and language.
fn laddered(mut cells: Vec<Cell>) -> Vec<Cell> {
    let mut groups: Vec<(String, Vec<usize>)> = Vec::new();
    for (at, cell) in cells.iter().enumerate() {
        let key = format!("{} {}", cell.variant, cell.language);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, members)) => members.push(at),
            None => groups.push((key, vec![at])),
        }
    }
    let mut steps = vec![(Step::default(), Step::default()); cells.len()];
    for (_, members) in &groups {
        let of = |price: fn(&Cell) -> Option<f64>| {
            let inputs: Vec<(&str, Option<f64>)> = members
                .iter()
                .map(|at| (cells[*at].condition.as_str(), price(&cells[*at])))
                .collect();
            ladder(&inputs)
        };
        let sell = of(|c| c.sell_at_price);
        let market = of(|c| c.tcg_market_price);
        for at in members {
            let condition = cells[*at].condition.as_str();
            steps[*at] = (
                sell.get(condition).copied().unwrap_or_default(),
                market.get(condition).copied().unwrap_or_default(),
            );
        }
    }
    let order: Vec<usize> = groups
        .into_iter()
        .flat_map(|(_, members)| members)
        .collect();
    let mut slots: Vec<Option<Cell>> = cells.drain(..).map(Some).collect();
    let mut out: Vec<Cell> = order
        .into_iter()
        .map(|at| {
            let mut cell = slots[at].take().expect("each cell is in one group");
            let (sell, market) = steps[at];
            cell.ladder_price = sell.price;
            cell.above_better_condition = sell.above_better_condition;
            cell.market_ladder_price = market.price;
            cell
        })
        .collect();
    out.sort_by(|a, b| {
        variant_rank(&a.variant)
            .cmp(&variant_rank(&b.variant))
            .then_with(|| condition_rank(&a.condition).cmp(&condition_rank(&b.condition)))
            .then_with(|| collate::compare(&a.language, &b.language))
    });
    out
}

/// `sortVariants`: the display order, then the rest alphabetically.
fn variants(cells: &[Cell]) -> Vec<String> {
    let mut variants: Vec<String> = Vec::new();
    for cell in cells {
        if !variants.contains(&cell.variant) {
            variants.push(cell.variant.clone());
        }
    }
    variants.sort_by(|a, b| match variant_rank(a).cmp(&variant_rank(b)) {
        Ordering::Equal => collate::compare(a, b),
        other => other,
    });
    variants
}

/// TCGplayer's price points for SKUs as the gateway answers them (`getPricePoints`).
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait PricePoints {
    async fn price_points(&self, skus: &[i64]) -> Result<Vec<Answer>, String>;
}

impl PricePoints for TcgPlayerMarket {
    async fn price_points(&self, skus: &[i64]) -> Result<Vec<Answer>, String> {
        self.answers(skus, Call::default()).await
    }
}

/// What prices the matrix's SKUs under the active policy (`PricingCalculator.calculatePrices`).
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Pricer {
    async fn price(
        &self,
        skus: &[PricerSku],
        config: &calculator::Config,
        market_prices: &HashMap<i64, f64>,
    ) -> Result<Vec<PricedItem>, String>;
}

/// The calculator over TCGplayer's latest sales and listings, each read once per matrix
/// (`resolveSuggestedPrice` with a fresh `PricingBatchApiCache`).
pub struct LatestSalesPricer {
    pub db: Database,
    pub tcg: TcgPlayer,
}

impl Pricer for LatestSalesPricer {
    async fn price(
        &self,
        skus: &[PricerSku],
        config: &calculator::Config,
        market_prices: &HashMap<i64, f64>,
    ) -> Result<Vec<PricedItem>, String> {
        let evidence = TcgPlayerEvidence {
            tcg: self.tcg.clone(),
            db: self.db.clone(),
            include_unverified_sellers: false,
        };
        let cached = Cached::new(&evidence);
        let now = Utc::now();
        let resolver = LatestSales {
            db: &self.db,
            evidence: &cached,
            now: now.timestamp_millis() as f64,
        };
        calculator::calculate(
            skus,
            config,
            market_prices,
            "product-price-matrix",
            &resolver,
            now,
            &mut |_| {},
        )
        .await
        .map(|calculation| calculation.priced_items)
        .map_err(|stopped| stopped.to_string())
    }
}

/// A SKU of the product as the catalog stores it.
#[derive(Clone, Debug, Deserialize)]
struct Sku {
    sku: i64,
    condition: String,
    variant: String,
    language: String,
}

/// The store's listing of a SKU (`ContinuousPricingInventoryItem`).
#[derive(sqlx::FromRow)]
struct Listed {
    sku: i32,
    quantity: i32,
    current_price: Option<f64>,
    in_stock: bool,
}

impl Listed {
    /// `listedPrice`: what the store lists it at, when it is listed and in stock.
    fn price(&self) -> Option<f64> {
        self.current_price
            .filter(|p| self.in_stock && self.quantity > 0 && *p > 0.0)
    }
}

/// The store's seller key and its listings of `skus` (`findStoreListings`). The listings sit
/// beside the market prices, so when they cannot be read the matrix goes without them.
async fn store_listings(db: &Database, skus: &[i64]) -> (Option<String>, Vec<Listed>) {
    let read = async {
        let seller = store::settings(db).await?.seller_key;
        if seller.is_empty() {
            return Ok((None, Vec::new()));
        }
        let skus: Vec<i32> = skus.iter().filter_map(|s| i32::try_from(*s).ok()).collect();
        let listings = if skus.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as(
                "SELECT sku, quantity, current_price::float8 AS current_price, in_stock
                FROM continuous_pricing_inventory WHERE seller_key = $1 AND sku = ANY($2::integer[])
                ORDER BY sku",
            )
            .bind(&seller)
            .bind(&skus)
            .fetch_all(&db.0)
            .await?
        };
        Ok::<_, sqlx::Error>((Some(seller), listings))
    };
    read.await.unwrap_or_else(|error| {
        eprintln!("[product-price-matrix] Store listings unavailable: {error}");
        (None, Vec::new())
    })
}

/// `product`'s prices in `language` (every language without one): TCGplayer's price points
/// read through `points`, the store's listings, and with `suggested`, the active policy's prices
/// from `pricer`. A product the catalog does not have is refused.
pub async fn matrix(
    db: &Database,
    points: &impl PricePoints,
    pricer: &impl Pricer,
    product: &Product,
    language: Option<&str>,
    suggested: bool,
) -> Result<Matrix, String> {
    let failed = |e: sqlx::Error| e.to_string();
    let stored: Option<sqlx::types::Json<Vec<Sku>>> = sqlx::query_scalar(
        "SELECT skus_json FROM products WHERE product_id = $1 AND product_line_id = $2",
    )
    .bind(product.product_id)
    .bind(product.product_line_id)
    .fetch_optional(&db.0)
    .await
    .map_err(failed)?;
    let Some(sqlx::types::Json(all)) = stored else {
        return Err(format!("Product {} not found", product.product_id));
    };
    let language = language.map(str::trim).filter(|l| !l.is_empty());
    let skus: Vec<Sku> = all
        .into_iter()
        .filter(|s| language.is_none_or(|l| s.language == l))
        .collect();
    let ids: Vec<i64> = skus.iter().map(|s| s.sku).collect();
    let (seller, listings) = store_listings(db, &ids).await;
    let answers = if ids.is_empty() {
        Vec::new()
    } else {
        points.price_points(&ids).await?
    };
    let points: HashMap<i64, &Answer> = answers.iter().map(|a| (a.sku_id, a)).collect();
    let listings: HashMap<i64, &Listed> = listings.iter().map(|l| (i64::from(l.sku), l)).collect();
    let (policy, priced) = if suggested && !skus.is_empty() {
        let stored = pricing_config::load(db).await.map_err(failed)?;
        let now = Utc::now();
        let config =
            calculator::config_of(&stored, seller.clone(), cost_model(db, &stored, now).await);
        let line = i64::from(product.product_line_id);
        let sources: Vec<PricerSku> = skus
            .iter()
            .map(|s| PricerSku {
                sku: s.sku,
                quantity: Some(1.0),
                add_to_quantity: None,
                current_price: listings.get(&s.sku).and_then(|l| l.price()),
                product_line_id: line,
                bypass_product_line_skips: true,
            })
            .collect();
        let market_prices: HashMap<i64, f64> = points
            .iter()
            .filter_map(|(sku, p)| Some((*sku, p.market_price?)))
            .collect();
        let priced = pricer.price(&sources, &config, &market_prices).await?;
        (
            Some(Policy::of(&stored, product.product_line_id)),
            priced.into_iter().map(|p| (p.sku, p)).collect(),
        )
    } else {
        (None, HashMap::new())
    };
    let cells: Vec<Cell> = skus
        .into_iter()
        .map(|s| {
            let point = points.get(&s.sku);
            let listing = listings.get(&s.sku);
            let priced: Option<&PricedItem> = priced.get(&s.sku);
            Cell {
                sku: s.sku,
                tcg_market_price: point.and_then(|p| p.market_price),
                lowest_sale_price: point.and_then(|p| p.lowest_price),
                highest_sale_price: point.and_then(|p| p.highest_price),
                sale_count: point.and_then(|p| p.price_count).map_or(0, |n| n as u64),
                listing: listing.map(|l| Listing {
                    price: l.current_price,
                    quantity: i64::from(l.quantity),
                    in_stock: l.in_stock,
                }),
                sell_at_price: priced.and_then(|p| p.price),
                ladder_price: None,
                market_ladder_price: None,
                above_better_condition: false,
                estimated_time_to_sell_days: priced.and_then(|p| p.estimated_time_to_sell_days),
                pricing_decision: priced
                    .and_then(|p| p.pricing_decision.as_ref())
                    .map(Decision::from),
                shadow_pricing_decision: priced
                    .and_then(|p| p.shadow_pricing_decision.as_ref())
                    .map(Decision::from),
                condition_normalization: priced
                    .and_then(|p| p.condition_normalization.as_ref())
                    .map(Normalization::from),
                warnings: priced.and_then(|p| p.warnings.clone()).unwrap_or_default(),
                errors: priced.map(|p| p.errors.clone()).unwrap_or_default(),
                condition: s.condition,
                variant: s.variant,
                language: s.language,
            }
        })
        .collect();
    let cells = laddered(cells);
    Ok(Matrix {
        variants: variants(&cells),
        cells,
        suggested_prices_included: suggested,
        policy,
        listings_included: seller.is_some(),
        priced_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::*;

    /// The price points as `.port-logs/matrix-cases.json` scripts them per SKU, noting the SKUs asked.
    struct ScriptedPoints {
        points: Value,
        asked: Mutex<Option<Vec<i64>>>,
    }

    impl PricePoints for ScriptedPoints {
        async fn price_points(&self, skus: &[i64]) -> Result<Vec<Answer>, String> {
            *self.asked.lock().unwrap() = Some(skus.to_vec());
            Ok(skus
                .iter()
                .filter_map(|sku| {
                    let mut point = self.points.get(sku.to_string())?.clone();
                    point["skuId"] = json!(sku);
                    Some(serde_json::from_value(point).unwrap())
                })
                .collect())
        }
    }

    /// What the calculator was asked: each SKU with its listed price, the seller left out of the
    /// listings, and the market prices.
    type Asked = (Vec<(i64, Option<f64>)>, Option<String>, HashMap<i64, f64>);

    /// The calculator as the cases script it, noting what it was asked.
    struct ScriptedPricer {
        priced: Value,
        asked: Mutex<Option<Asked>>,
    }

    impl Pricer for ScriptedPricer {
        async fn price(
            &self,
            skus: &[PricerSku],
            config: &calculator::Config,
            market_prices: &HashMap<i64, f64>,
        ) -> Result<Vec<PricedItem>, String> {
            assert!(skus.iter().all(|s| s.bypass_product_line_skips
                && s.quantity == Some(1.0)
                && s.add_to_quantity.is_none()));
            *self.asked.lock().unwrap() = Some((
                skus.iter().map(|s| (s.sku, s.current_price)).collect(),
                config.excluded_seller_key.clone(),
                market_prices.clone(),
            ));
            let strings = |v: &Value| {
                v.as_array()
                    .map(|a| a.iter().map(|s| s.as_str().unwrap().to_owned()).collect())
            };
            fn parsed<T: serde::de::DeserializeOwned>(v: &Value) -> Option<T> {
                v.is_object()
                    .then(|| serde_json::from_value(v.clone()).unwrap())
            }
            Ok(skus
                .iter()
                .filter_map(|s| {
                    let p = self.priced.get(s.sku.to_string())?;
                    Some(PricedItem {
                        sku: s.sku,
                        price: p["price"].as_f64(),
                        suggested_price: p["suggestedPrice"].as_f64(),
                        estimated_time_to_sell_days: p["estimatedTimeToSellDays"].as_f64(),
                        pricing_decision: parsed(&p["pricingDecision"]),
                        shadow_pricing_decision: parsed(&p["shadowPricingDecision"]),
                        condition_normalization: parsed(&p["conditionNormalization"]),
                        warnings: strings(&p["warnings"]),
                        errors: strings(&p["errors"]).unwrap_or_default(),
                        ..PricedItem::default()
                    })
                })
                .collect())
        }
    }

    /// Each case in `.port-logs/matrix-cases.json` against Node's `createProductPriceMatrixAction`
    /// over the same (`.port-logs/matrix-node.ts`), on the dev database with the store listings
    /// `matrix-seed.sql` adds in a transaction rolled back: the matrix, or the refusal, and what the price
    /// points and the calculator were asked. The pool has one connection, so every read is in the
    /// transaction.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's run in .port-logs"]
    async fn matrices_are_built_as_node_builds_them() {
        crate::config::load_env();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy(&crate::config::database_url())
            .unwrap();
        let db = Database(pool);
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("matrix.node.json")).unwrap();
        let cases: Value = serde_json::from_str(&read("matrix-cases.json")).unwrap();
        sqlx::raw_sql(&format!("BEGIN; {}", read("matrix-seed.sql")))
            .execute(&db.0)
            .await
            .unwrap();
        let mut failures = Vec::new();
        for (case, node) in cases["cases"].as_array().unwrap().iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let points = ScriptedPoints {
                points: cases["points"].clone(),
                asked: Mutex::default(),
            };
            let pricer = ScriptedPricer {
                priced: cases["priced"].clone(),
                asked: Mutex::default(),
            };
            let product = Product {
                product_id: case["productId"].as_i64().unwrap() as i32,
                product_line_id: case["productLineId"].as_i64().unwrap() as i32,
                ..crate::features::product_price_matrix::products::tests::product(0, &[])
            };
            let ours = matrix(
                &db,
                &points,
                &pricer,
                &product,
                case["language"].as_str(),
                case["includeSuggestedPrices"] == true,
            )
            .await;
            match ours {
                Err(error) => {
                    if node["status"] != 404 || node["body"]["error"] != error.as_str() {
                        failures.push(format!("{name}: refused {error}, Node {node}"));
                    }
                }
                Ok(mut ours) => {
                    let theirs: Matrix = serde_json::from_value(node["body"].clone()).unwrap();
                    ours.priced_at.clone_from(&theirs.priced_at);
                    if ours != theirs {
                        failures.push(format!("{name}: {ours:#?}\nNode: {theirs:#?}"));
                    }
                    let asked = &node["asked"];
                    let points_asked: Option<Vec<i64>> = asked
                        .get("points")
                        .map(|p| serde_json::from_value(p.clone()).unwrap());
                    if *points.asked.lock().unwrap() != points_asked {
                        failures.push(format!("{name}: price points asked differ"));
                    }
                    let priced: Option<Asked> = asked.get("priced").map(|skus| {
                        (
                            skus.as_array()
                                .unwrap()
                                .iter()
                                .map(|s| (s["sku"].as_i64().unwrap(), s["currentPrice"].as_f64()))
                                .collect(),
                            asked["excludedSellerKey"].as_str().map(str::to_owned),
                            asked["marketPrices"]
                                .as_object()
                                .unwrap()
                                .iter()
                                .filter_map(|(sku, p)| Some((sku.parse().unwrap(), p.as_f64()?)))
                                .collect(),
                        )
                    });
                    if *pricer.asked.lock().unwrap() != priced {
                        failures.push(format!(
                            "{name}: calculator asked {:?}, Node {priced:?}",
                            pricer.asked.lock().unwrap()
                        ));
                    }
                }
            }
        }
        let seeded: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM continuous_pricing_inventory WHERE product_id = 86897 AND product_name = 'port'",
        )
        .fetch_one(&db.0)
        .await
        .unwrap();
        sqlx::raw_sql("ROLLBACK").execute(&db.0).await.unwrap();
        assert_eq!(seeded, 2, "the reads were in the seeding transaction");
        assert!(failures.is_empty(), "{}", failures.join("\n\n"));
    }

    #[test]
    fn a_ladder_clamps_a_worse_condition_to_a_better_ones_price() {
        let steps = ladder(&[
            ("Lightly Played", Some(5.0)),
            ("Unopened", Some(9.999)),
            ("Near Mint", Some(4.005)),
            ("Moderately Played", None),
            ("Heavily Played", Some(3.0)),
        ]);
        let step = |c: &str| steps[c];
        assert_eq!(step("Near Mint").price, Some(4.01));
        assert_eq!(
            step("Lightly Played"),
            Step {
                price: Some(4.01),
                above_better_condition: true
            }
        );
        assert_eq!(step("Moderately Played"), Step::default());
        assert_eq!(step("Heavily Played").price, Some(3.0));
        assert_eq!(step("Unopened").price, Some(10.0));
    }

    /// `conditionLadder.test.ts`'s refund cases.
    #[test]
    fn a_refund_leaves_the_buyer_paying_what_they_received() {
        assert_eq!(
            refund(Some(48.61), Some(34.99)),
            Some(Refund {
                refund: 13.62,
                net: 34.99
            })
        );
        assert_eq!(
            refund(Some(12.0), Some(12.5)),
            Some(Refund {
                refund: 0.0,
                net: 12.0
            })
        );
        assert_eq!(refund(None, Some(6.0)), None);
        assert_eq!(refund(Some(5.0), Some(0.0)), None);
    }

    #[test]
    fn labels_read_as_the_react_screen_wrote_them() {
        assert_eq!(days(Some(7.46)), "7.5 days");
        assert_eq!(days(Some(7.0)), "7 days");
        assert_eq!(days(Some(1234.4)), "1,234 days");
        assert_eq!(days(None), "N/A");
        assert_eq!(
            [1.0, 2.0, 3.0, 11.0, 12.4, 22.0, 65.0].map(ordinal),
            ["1st", "2nd", "3rd", "11th", "12th", "22nd", "65th"]
        );
        let policy: Policy = serde_json::from_value(
            serde_json::json!({ "method": "profit-per-day", "dailyReturnHurdle": 0.005 }),
        )
        .unwrap();
        assert_eq!(policy.describe(), "Profit per day at a 0.50%/day hurdle");
        let policy: Policy = serde_json::from_value(
            serde_json::json!({ "method": "target-horizon", "horizonDays": 30 }),
        )
        .unwrap();
        assert_eq!(policy.describe(), "Target horizon of 30 days");
    }
}
