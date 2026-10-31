//! The pricing configuration every pricing run reads (`pricing_config`), as
//! `features/pricing/types/config.ts` reads and writes it. Each section of the screen saves only
//! its own keys, merged into the stored document in one statement, so two sections saved at once
//! cannot undo each other, and keys this screen does not show (`maxListingsPerSku`) are kept.
use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::database::Database;

const CONFIG_KEY: &str = "default";

/// How prices are chosen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Policy {
    /// Each product line's percentile of the sell-time curve.
    Percentile,
    /// One median sell time for the whole inventory, in days.
    TargetHorizon(f64),
    /// The price whose net proceeds, discounted over its sell time, are highest.
    ProfitPerDay,
}

pub const DEFAULT_HORIZON_DAYS: f64 = 33.5;

#[derive(Clone, Debug, PartialEq)]
pub struct ProfitPerDay {
    pub daily_return_hurdle: f64,
    pub relative_overhead: f64,
    pub static_overhead_per_unit: f64,
}

impl ProfitPerDay {
    pub fn hurdle_is_valid(value: f64) -> bool {
        value > 0.0 && value < 1.0
    }

    pub fn overhead_is_valid(value: f64) -> bool {
        (0.0..1.0).contains(&value)
    }

    pub fn static_overhead_is_valid(value: f64) -> bool {
        value >= 0.0
    }
}

/// The pricing section.
#[derive(Clone, Debug, PartialEq)]
pub struct Pricing {
    pub policy: Policy,
    pub profit_per_day: ProfitPerDay,
    pub default_percentile: f64,
    pub percentile_step: f64,
    pub min_percentile: f64,
    pub max_percentile: f64,
    pub skip_prefix: String,
    pub min_price_multiplier: f64,
    pub min_price_constant: f64,
    pub success_rate_low: f64,
    pub success_rate_high: f64,
}

impl Default for Pricing {
    fn default() -> Self {
        Pricing {
            policy: Policy::Percentile,
            profit_per_day: ProfitPerDay {
                daily_return_hurdle: 0.005,
                relative_overhead: 0.15,
                static_overhead_per_unit: 0.3,
            },
            default_percentile: 65.0,
            percentile_step: 5.0,
            min_percentile: 5.0,
            max_percentile: 95.0,
            skip_prefix: "C-".into(),
            min_price_multiplier: 80.0 / 85.0,
            min_price_constant: 0.1,
            success_rate_low: 70.0,
            success_rate_high: 90.0,
        }
    }
}

/// An order value where shipping changes: under $5 the buyer pays it, from $5 it is free, from
/// $50 orders ship tracked, from $250 with a signature.
pub const SHIPPING_THRESHOLDS: [u32; 3] = [5, 50, 250];
/// How many trailing days of orders the shipping cost model may learn from.
pub const EVIDENCE_WINDOWS: [u32; 5] = [30, 60, 90, 180, 365];

/// Listing one cent under a shipping threshold when the learned shipping costs make it pay.
#[derive(Clone, Debug, PartialEq)]
pub struct Snaps {
    pub enabled: bool,
    pub thresholds: Vec<u32>,
    /// A price up to this fraction above a threshold may be snapped under it.
    pub snap_range: f64,
    pub evidence_window_days: u32,
}

impl Default for Snaps {
    fn default() -> Self {
        Snaps {
            enabled: true,
            thresholds: SHIPPING_THRESHOLDS.to_vec(),
            snap_range: 0.1,
            evidence_window_days: 90,
        }
    }
}

impl Snaps {
    pub fn range_is_valid(value: f64) -> bool {
        value > 0.0 && value <= 0.5
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Supply {
    pub enabled: bool,
    pub include_unverified_sellers: bool,
}

impl Default for Supply {
    fn default() -> Self {
        Supply {
            enabled: true,
            include_unverified_sellers: false,
        }
    }
}

/// A product line priced differently from the default, or not priced at all.
#[derive(Clone, Debug, PartialEq)]
pub struct LineSetting {
    pub percentile: f64,
    pub skip: bool,
    /// Its own profit-per-day hurdle; never kept for a skipped line.
    pub daily_return_hurdle: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProductLines {
    pub default_percentile: f64,
    pub settings: BTreeMap<i32, LineSetting>,
}

impl Default for ProductLines {
    fn default() -> Self {
        ProductLines {
            default_percentile: 65.0,
            settings: BTreeMap::new(),
        }
    }
}

/// The whole stored configuration.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Config {
    pub pricing: Pricing,
    pub snaps: Snaps,
    pub supply: Supply,
    pub product_lines: ProductLines,
}

/// A number as JSON: whole numbers without a fraction, as JavaScript writes them.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

impl Config {
    /// The stored documents, read as `normalizeServerPricingConfig` reads them: a value that is
    /// missing, of the wrong type or out of range is its default.
    pub fn of(pricing: &Value, supply: &Value, product_lines: &Value) -> Self {
        let d = Config::default();
        let num = |value: &Value, fallback: f64| value.as_f64().unwrap_or(fallback);
        let valid = |value: &Value, fallback: f64, ok: fn(f64) -> bool| {
            value.as_f64().filter(|n| ok(*n)).unwrap_or(fallback)
        };
        let policy = match pricing["policy"]["method"].as_str() {
            Some("target-horizon") => pricing["policy"]["horizonDays"]
                .as_f64()
                .filter(|days| *days > 0.0)
                .map_or(Policy::Percentile, Policy::TargetHorizon),
            Some("profit-per-day") => Policy::ProfitPerDay,
            _ => Policy::Percentile,
        };
        let ppd = &pricing["profitPerDay"];
        let dp = &d.pricing;
        let snaps = &pricing["shippingThresholdSnaps"];
        Config {
            pricing: Pricing {
                policy,
                profit_per_day: ProfitPerDay {
                    daily_return_hurdle: valid(
                        &ppd["dailyReturnHurdle"],
                        dp.profit_per_day.daily_return_hurdle,
                        ProfitPerDay::hurdle_is_valid,
                    ),
                    relative_overhead: valid(
                        &ppd["relativeOverhead"],
                        dp.profit_per_day.relative_overhead,
                        ProfitPerDay::overhead_is_valid,
                    ),
                    static_overhead_per_unit: valid(
                        &ppd["staticOverheadPerUnit"],
                        dp.profit_per_day.static_overhead_per_unit,
                        ProfitPerDay::static_overhead_is_valid,
                    ),
                },
                default_percentile: num(&pricing["defaultPercentile"], dp.default_percentile),
                percentile_step: num(&pricing["percentileStep"], dp.percentile_step),
                min_percentile: num(&pricing["minPercentile"], dp.min_percentile),
                max_percentile: num(&pricing["maxPercentile"], dp.max_percentile),
                skip_prefix: pricing["skipPrefix"]
                    .as_str()
                    .map_or_else(|| dp.skip_prefix.clone(), str::to_owned),
                min_price_multiplier: num(&pricing["minPriceMultiplier"], dp.min_price_multiplier),
                min_price_constant: num(&pricing["minPriceConstant"], dp.min_price_constant),
                success_rate_low: num(&pricing["successRateThreshold"]["low"], dp.success_rate_low),
                success_rate_high: num(
                    &pricing["successRateThreshold"]["high"],
                    dp.success_rate_high,
                ),
            },
            snaps: Snaps {
                enabled: snaps["enabled"].as_bool().unwrap_or(d.snaps.enabled),
                thresholds: match snaps["thresholds"].as_array() {
                    Some(listed) => SHIPPING_THRESHOLDS
                        .into_iter()
                        .filter(|t| listed.iter().any(|v| v.as_f64() == Some(f64::from(*t))))
                        .collect(),
                    None => d.snaps.thresholds.clone(),
                },
                snap_range: valid(
                    &snaps["snapRange"],
                    d.snaps.snap_range,
                    Snaps::range_is_valid,
                ),
                evidence_window_days: EVIDENCE_WINDOWS
                    .into_iter()
                    .find(|days| snaps["evidenceWindowDays"].as_f64() == Some(f64::from(*days)))
                    .unwrap_or(d.snaps.evidence_window_days),
            },
            supply: Supply {
                enabled: supply["enableSupplyAnalysis"]
                    .as_bool()
                    .unwrap_or(d.supply.enabled),
                include_unverified_sellers: supply["includeUnverifiedSellers"]
                    .as_bool()
                    .unwrap_or(d.supply.include_unverified_sellers),
            },
            product_lines: ProductLines {
                default_percentile: num(
                    &product_lines["defaultPercentile"],
                    d.product_lines.default_percentile,
                ),
                settings: product_lines["productLineSettings"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(id, setting)| {
                        let id = id.parse::<i32>().ok()?;
                        let skip = setting["skip"].as_bool().unwrap_or(false);
                        let hurdle = setting["dailyReturnHurdle"]
                            .as_f64()
                            .filter(|h| !skip && ProfitPerDay::hurdle_is_valid(*h));
                        let percentile =
                            num(&setting["percentile"], d.product_lines.default_percentile);
                        Some((
                            id,
                            LineSetting {
                                percentile,
                                skip,
                                daily_return_hurdle: hurdle,
                            },
                        ))
                    })
                    .collect(),
            },
        }
    }
}

impl Pricing {
    /// This section's keys of `pricing_json`. The snaps share the document but not the section.
    /// `pricing_json.policy`.
    pub fn policy_document(&self) -> Value {
        match self.policy {
            Policy::Percentile => json!({ "method": "percentile" }),
            Policy::TargetHorizon(days) => {
                json!({ "method": "target-horizon", "horizonDays": number(days) })
            }
            Policy::ProfitPerDay => json!({ "method": "profit-per-day" }),
        }
    }

    /// `pricing_json.profitPerDay`.
    pub fn profit_per_day_document(&self) -> Value {
        let ppd = &self.profit_per_day;
        json!({
            "dailyReturnHurdle": number(ppd.daily_return_hurdle),
            "relativeOverhead": number(ppd.relative_overhead),
            "staticOverheadPerUnit": number(ppd.static_overhead_per_unit),
        })
    }

    fn document(&self) -> Value {
        json!({
            "policy": self.policy_document(),
            "profitPerDay": self.profit_per_day_document(),
            "defaultPercentile": number(self.default_percentile),
            "percentileStep": number(self.percentile_step),
            "minPercentile": number(self.min_percentile),
            "maxPercentile": number(self.max_percentile),
            "skipPrefix": self.skip_prefix,
            "minPriceMultiplier": number(self.min_price_multiplier),
            "minPriceConstant": number(self.min_price_constant),
            "successRateThreshold": {
                "low": number(self.success_rate_low),
                "high": number(self.success_rate_high),
            },
        })
    }
}

impl Snaps {
    fn document(&self) -> Value {
        json!({ "shippingThresholdSnaps": {
            "enabled": self.enabled,
            "thresholds": self.thresholds,
            "snapRange": number(self.snap_range),
            "evidenceWindowDays": self.evidence_window_days,
        }})
    }
}

impl Supply {
    fn document(&self) -> Value {
        json!({
            "enableSupplyAnalysis": self.enabled,
            "includeUnverifiedSellers": self.include_unverified_sellers,
        })
    }
}

impl LineSetting {
    fn document(&self) -> Value {
        let mut setting = Map::new();
        setting.insert("percentile".into(), number(self.percentile));
        setting.insert("skip".into(), self.skip.into());
        if let Some(hurdle) = self.daily_return_hurdle.filter(|_| !self.skip) {
            setting.insert("dailyReturnHurdle".into(), number(hurdle));
        }
        Value::Object(setting)
    }
}

/// `{ ...defaults, ...stored }` on JSON objects: the stored keys over the defaults', unknown ones kept.
fn spread(defaults: Value, stored: &Value) -> Map<String, Value> {
    let mut merged = match defaults {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Some(stored) = stored.as_object() {
        merged.extend(stored.clone());
    }
    merged
}

/// Whether JavaScript reads the value as true.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The stored documents as `normalizeServerPricingConfig` returns them, the document a pricing job
/// is queued with: each section's stored keys over its defaults, unknown keys kept, and the policy,
/// profit per day, snaps and per-line settings read as [`Config::of`] reads them. The retired
/// `forecastCorrection` is dropped.
pub fn normalized(pricing: &Value, supply: &Value, product_lines: &Value) -> Value {
    let read = Config::of(pricing, supply, product_lines);
    let defaults = Config::default();
    let mut stored_pricing = pricing.as_object().cloned().unwrap_or_default();
    stored_pricing.remove("forecastCorrection");
    let mut pricing_section = spread(defaults.pricing.document(), &Value::Object(stored_pricing));
    pricing_section.insert("policy".into(), read.pricing.policy_document());
    pricing_section.insert(
        "profitPerDay".into(),
        read.pricing.profit_per_day_document(),
    );
    pricing_section.extend(
        read.snaps
            .document()
            .as_object()
            .expect("an object")
            .clone(),
    );
    pricing_section.insert(
        "successRateThreshold".into(),
        Value::Object(spread(
            json!({
                "low": number(defaults.pricing.success_rate_low),
                "high": number(defaults.pricing.success_rate_high),
            }),
            &pricing["successRateThreshold"],
        )),
    );
    let mut lines = spread(
        json!({ "productLineSettings": {}, "defaultPercentile": number(defaults.product_lines.default_percentile) }),
        product_lines,
    );
    let settings: Map<String, Value> = product_lines["productLineSettings"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, setting)| truthy(setting))
        .map(|(id, setting)| {
            let mut kept = setting.as_object().cloned().unwrap_or_default();
            let hurdle = kept.remove("dailyReturnHurdle");
            if let Some(hurdle) = hurdle.filter(|h| {
                !kept.get("skip").is_some_and(truthy)
                    && h.as_f64().is_some_and(ProfitPerDay::hurdle_is_valid)
            }) {
                kept.insert("dailyReturnHurdle".into(), hurdle);
            }
            (id.clone(), Value::Object(kept))
        })
        .collect();
    lines.insert("productLineSettings".into(), Value::Object(settings));
    json!({
        "pricing": pricing_section,
        "supplyAnalysis": spread(defaults.supply.document(), supply),
        "productLinePricing": lines,
    })
}

/// The stored configuration; the defaults when there is none yet (the Node app writes them on
/// its first read, and so does the first save here).
pub async fn load(db: &Database) -> sqlx::Result<Config> {
    let row: Option<(Value, Value, Value)> = sqlx::query_as(
        "SELECT pricing_json, supply_analysis_json, product_line_pricing_json
        FROM pricing_config WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .fetch_optional(&db.0)
    .await?;
    Ok(
        row.map_or_else(Config::default, |(pricing, supply, lines)| {
            Config::of(&pricing, &supply, &lines)
        }),
    )
}

/// Merges `pricing`, `supply` and `lines` into the stored documents, each `||` its own column;
/// an empty object leaves a column as it is.
async fn merge(db: &Database, pricing: Value, supply: Value, lines: Value) -> sqlx::Result<()> {
    let defaults = Config::default();
    let mut first = defaults.pricing.document();
    first.as_object_mut().expect("an object").extend(
        defaults
            .snaps
            .document()
            .as_object()
            .expect("an object")
            .clone(),
    );
    sqlx::query(
        "INSERT INTO pricing_config (config_key, pricing_json, supply_analysis_json, product_line_pricing_json, updated_at)
        VALUES ($1, $5 || $2, $6 || $3, $7 || $4, NOW())
        ON CONFLICT (config_key) DO UPDATE SET
            pricing_json = pricing_config.pricing_json || $2,
            supply_analysis_json = pricing_config.supply_analysis_json || $3,
            product_line_pricing_json = pricing_config.product_line_pricing_json || $4,
            updated_at = NOW()",
    )
    .bind(CONFIG_KEY)
    .bind(pricing)
    .bind(supply)
    .bind(lines)
    .bind(first)
    .bind(defaults.supply.document())
    .bind(json!({ "defaultPercentile": number(defaults.product_lines.default_percentile), "productLineSettings": {} }))
    .execute(&db.0)
    .await?;
    Ok(())
}

pub async fn save_pricing(db: &Database, pricing: &Pricing) -> sqlx::Result<()> {
    merge(db, pricing.document(), json!({}), json!({})).await
}

pub async fn save_snaps(db: &Database, snaps: &Snaps) -> sqlx::Result<()> {
    merge(db, snaps.document(), json!({}), json!({})).await
}

pub async fn save_supply(db: &Database, supply: &Supply) -> sqlx::Result<()> {
    merge(db, json!({}), supply.document(), json!({})).await
}

pub async fn save_default_percentile(db: &Database, percentile: f64) -> sqlx::Result<()> {
    merge(
        db,
        json!({}),
        json!({}),
        json!({ "defaultPercentile": number(percentile) }),
    )
    .await
}

/// Sets one product line's setting, leaving the others as stored.
pub async fn set_line(db: &Database, id: i32, setting: &LineSetting) -> sqlx::Result<()> {
    merge(db, json!({}), json!({}), json!({})).await?;
    sqlx::query(
        "UPDATE pricing_config SET product_line_pricing_json = jsonb_set(
            product_line_pricing_json || jsonb_build_object('productLineSettings',
                COALESCE(product_line_pricing_json -> 'productLineSettings', '{}'::jsonb)),
            ARRAY['productLineSettings', $2], $3),
            updated_at = NOW()
        WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .bind(id.to_string())
    .bind(setting.document())
    .execute(&db.0)
    .await?;
    Ok(())
}

pub async fn remove_line(db: &Database, id: i32) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pricing_config SET product_line_pricing_json = product_line_pricing_json #- ARRAY['productLineSettings', $2],
            updated_at = NOW()
        WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .bind(id.to_string())
    .execute(&db.0)
    .await?;
    Ok(())
}

/// Every setting back to its default, as the React app's reset wrote them: the whole documents,
/// keys this screen does not show included.
pub async fn reset(db: &Database) -> sqlx::Result<()> {
    let d = Config::default();
    let mut pricing = d.pricing.document();
    pricing
        .as_object_mut()
        .expect("an object")
        .extend(d.snaps.document().as_object().expect("an object").clone());
    sqlx::query(
        "INSERT INTO pricing_config (config_key, pricing_json, supply_analysis_json, product_line_pricing_json, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (config_key) DO UPDATE SET pricing_json = $2, supply_analysis_json = $3,
            product_line_pricing_json = $4, updated_at = NOW()",
    )
    .bind(CONFIG_KEY)
    .bind(pricing)
    .bind(d.supply.document())
    .bind(json!({ "defaultPercentile": number(d.product_lines.default_percentile), "productLineSettings": {} }))
    .execute(&db.0)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `normalizeServerPricingConfig`'s output for stored documents current, old, odd and empty
    /// (`fixtures/normalized.json`, written by running it on each input).
    #[test]
    fn documents_normalize_as_node_normalizes_them() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("fixtures/normalized.json")).expect("the fixture");
        for case in cases {
            let input = &case["input"];
            assert_eq!(
                normalized(
                    &input["pricing"],
                    &input["supplyAnalysis"],
                    &input["productLinePricing"]
                ),
                case["output"],
                "for {input}"
            );
        }
    }

    #[test]
    fn a_stored_config_reads_as_the_node_app_reads_it() {
        let pricing = json!({
            "policy": { "method": "target-horizon", "horizonDays": -2 },
            "profitPerDay": { "dailyReturnHurdle": 1.5, "staticOverheadPerUnit": 0 },
            "skipPrefix": "X-",
            "successRateThreshold": { "low": 60 },
            "shippingThresholdSnaps": { "thresholds": [250, 7, 5], "evidenceWindowDays": 45 }
        });
        let lines = json!({ "productLineSettings": {
            "3": { "skip": false, "percentile": 75, "dailyReturnHurdle": 0.01 },
            "68": { "skip": true, "percentile": 70, "dailyReturnHurdle": 0.01 },
            "x": { "skip": false, "percentile": 1 }
        }});
        let config = Config::of(&pricing, &json!({ "maxListingsPerSku": 200 }), &lines);
        assert_eq!(
            config.pricing.policy,
            Policy::Percentile,
            "a horizon of no days"
        );
        assert_eq!(config.pricing.profit_per_day.daily_return_hurdle, 0.005);
        assert_eq!(config.pricing.profit_per_day.static_overhead_per_unit, 0.0);
        assert_eq!(config.pricing.skip_prefix, "X-");
        assert_eq!(
            (
                config.pricing.success_rate_low,
                config.pricing.success_rate_high
            ),
            (60.0, 90.0)
        );
        assert_eq!(config.snaps.thresholds, [5, 250]);
        assert_eq!(config.snaps.evidence_window_days, 90);
        assert!(config.supply.enabled);
        assert_eq!(
            config.product_lines.settings[&3].daily_return_hurdle,
            Some(0.01)
        );
        assert_eq!(
            config.product_lines.settings[&68].daily_return_hurdle, None,
            "a skipped line"
        );
        assert_eq!(config.product_lines.settings.len(), 2);
    }

    #[test]
    fn written_settings_read_back_the_same() {
        let mut config = Config::default();
        config.pricing.policy = Policy::TargetHorizon(12.5);
        config.snaps.thresholds = vec![50];
        config.supply.include_unverified_sellers = true;
        config.product_lines.settings.insert(
            85,
            LineSetting {
                percentile: 70.0,
                skip: false,
                daily_return_hurdle: Some(0.004),
            },
        );
        let mut pricing = config.pricing.document();
        pricing
            .as_object_mut()
            .unwrap()
            .extend(config.snaps.document().as_object().unwrap().clone());
        let settings: Map<String, Value> = config
            .product_lines
            .settings
            .iter()
            .map(|(id, s)| (id.to_string(), s.document()))
            .collect();
        let lines = json!({ "defaultPercentile": 65, "productLineSettings": settings });
        assert_eq!(
            Config::of(&pricing, &config.supply.document(), &lines),
            config
        );
    }

    #[test]
    fn whole_numbers_are_written_without_a_fraction() {
        assert_eq!(
            Pricing::default().document()["defaultPercentile"].to_string(),
            "65"
        );
        assert_eq!(number(0.1).to_string(), "0.1");
    }
}
