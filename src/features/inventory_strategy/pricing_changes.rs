//! The days pricing changed, to read margin moves against: the last configuration a pricing job
//! first used that day compared with the one in use before it. Ported from `pricingChanges.ts`
//! and the policy labels of `policyLabel.ts`.
use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::types::Json;

use crate::{
    database::Database,
    features::configuration::config::{Config, Policy},
};

/// A pricing configuration and model version, and when a pricing job first used it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ConfigurationUse {
    pub first_priced_at: DateTime<Utc>,
    pub config: Json<Value>,
    pub model_version: Option<String>,
}

/// What changed in how inventory was priced on one day.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingChange {
    /// The UTC day of the change, as YYYY-MM-DD.
    pub changed_on: String,
    pub changes: Vec<String>,
}

/// Each distinct configuration and model version completed pricing jobs used since `since`, and
/// when each was first used.
pub async fn history(db: &Database, since: DateTime<Utc>) -> sqlx::Result<Vec<ConfigurationUse>> {
    sqlx::query_as(
        r#"WITH completed AS (
            SELECT job.created_at, job.config_json - 'updatedAt' AS config,
              (SELECT result.pricing_details_json->>'pricingModelVersion' FROM inventory_batch_results result
               WHERE result.batch_number = job.batch_number AND result.pricing_details_json IS NOT NULL
               LIMIT 1) AS model_version
            FROM inventory_batch_pricing_jobs job
            WHERE job.status = 'completed' AND job.created_at >= $1
          )
          SELECT DISTINCT ON (config, model_version)
            created_at AS first_priced_at, config, model_version
          FROM completed
          ORDER BY config, model_version, created_at"#,
    )
    .bind(since)
    .fetch_all(&db.0)
    .await
}

/// "7.5 days", "120 days": whole days from 100 up, tenths below.
pub fn format_days(days: f64) -> String {
    if !days.is_finite() {
        return "N/A".into();
    }
    let rounded = if days >= 100.0 {
        (days + 0.5).floor()
    } else {
        ((days * 10.0) + 0.5).floor() / 10.0
    };
    let whole = rounded.trunc() as i64;
    let tenths = ((rounded - rounded.trunc()) * 10.0).round() as i64;
    let mut grouped = String::new();
    for (i, c) in whole.abs().to_string().chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let mut text: String = grouped.chars().rev().collect();
    if whole < 0 {
        text.insert(0, '-');
    }
    if tenths != 0 {
        text.push_str(&format!(".{}", tenths.abs()));
    }
    format!("{text} days")
}

/// "0.50%/day".
pub fn format_hurdle(daily_return_hurdle: f64) -> String {
    format!("{:.2}%/day", daily_return_hurdle * 100.0)
}

/// "65th", "1st", "12th".
pub fn format_percentile(percentile: f64) -> String {
    let rounded = (percentile + 0.5).floor() as i64;
    let suffix = match (rounded % 100, rounded % 10) {
        (11..=13, _) => "th",
        (_, 1) => "st",
        (_, 2) => "nd",
        (_, 3) => "rd",
        _ => "th",
    };
    format!("{rounded}{suffix}")
}

/// The active policy as a sentence fragment.
pub fn describe_policy(config: &Config) -> String {
    match config.pricing.policy {
        Policy::Percentile => "Configured percentile per product line".into(),
        Policy::TargetHorizon(days) => format!("Target horizon of {}", format_days(days)),
        Policy::ProfitPerDay => format!(
            "Profit per day at a {} hurdle",
            format_hurdle(config.pricing.profit_per_day.daily_return_hurdle)
        ),
    }
}

/// The pricing keys the normalization reads; any other stored key is kept as it was, so it
/// counts as a change too.
const PRICING_KEYS: [&str; 12] = [
    "policy",
    "profitPerDay",
    "shippingThresholdSnaps",
    "successRateThreshold",
    "defaultPercentile",
    "percentileStep",
    "minPercentile",
    "maxPercentile",
    "skipPrefix",
    "minPriceMultiplier",
    "minPriceConstant",
    "forecastCorrection",
];

fn read(config: &Value) -> (Config, Map<String, Value>) {
    let normalized = Config::of(
        &config["pricing"],
        &config["supplyAnalysis"],
        &config["productLinePricing"],
    );
    let extra = config["pricing"]
        .as_object()
        .map(|p| {
            p.iter()
                .filter(|(k, _)| !PRICING_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    (normalized, extra)
}

fn describe_change(previous: &ConfigurationUse, current: &ConfigurationUse) -> Vec<String> {
    let (before, before_extra) = read(&previous.config.0);
    let (after, after_extra) = read(&current.config.0);
    let mut changes = Vec::new();
    let policy = describe_policy(&after);
    if policy != describe_policy(&before) {
        changes.push(format!("Policy: {policy}"));
    }
    if before.product_lines != after.product_lines {
        changes.push(format!(
            "Product line settings (default {} percentile)",
            format_percentile(after.product_lines.default_percentile)
        ));
    }
    if let Some(version) = current.model_version.as_deref().filter(|v| !v.is_empty())
        && current.model_version != previous.model_version
    {
        changes.push(format!("Pricing model {version}"));
    }
    if changes.is_empty() && (before != after || before_extra != after_extra) {
        changes.push("Pricing settings".into());
    }
    changes
}

/// The days pricing changed on or after `since` (YYYY-MM-DD).
pub fn describe(history: &[ConfigurationUse], since: &str) -> Vec<PricingChange> {
    let mut ordered: Vec<&ConfigurationUse> = history.iter().collect();
    ordered.sort_by_key(|u| u.first_priced_at);
    let mut last_of_day: BTreeMap<String, &ConfigurationUse> = BTreeMap::new();
    for used in ordered {
        last_of_day.insert(used.first_priced_at.format("%Y-%m-%d").to_string(), used);
    }
    let days: Vec<(&String, &&ConfigurationUse)> = last_of_day.iter().collect();
    days.iter()
        .enumerate()
        .skip(1)
        .filter(|(_, (day, _))| day.as_str() >= since)
        .filter_map(|(index, (day, current))| {
            let changes = describe_change(days[index - 1].1, current);
            (!changes.is_empty()).then(|| PricingChange {
                changed_on: (*day).clone(),
                changes,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn used(at: &str, config: Value, model: Option<&str>) -> ConfigurationUse {
        ConfigurationUse {
            first_priced_at: at.parse().unwrap(),
            config: Json(config),
            model_version: model.map(str::to_owned),
        }
    }

    #[test]
    fn each_day_pricing_changed_says_what_changed() {
        let percentile = json!({ "pricing": {}, "supplyAnalysis": {}, "productLinePricing": { "defaultPercentile": 65 } });
        let horizon = |days: f64| json!({ "pricing": { "policy": { "method": "target-horizon", "horizonDays": days } }, "supplyAnalysis": {}, "productLinePricing": { "defaultPercentile": 65 } });
        let profit_per_day = json!({
            "pricing": { "policy": { "method": "profit-per-day" }, "profitPerDay": { "dailyReturnHurdle": 0.005, "relativeOverhead": 0.15, "staticOverheadPerUnit": 0.3 } },
            "supplyAnalysis": {},
            "productLinePricing": { "defaultPercentile": 65 }
        });
        let mut updated = profit_per_day.clone();
        updated["updatedAt"] = json!("ignored");
        let mut seventy = profit_per_day.clone();
        seventy["productLinePricing"] = json!({ "defaultPercentile": 70 });
        let changes = describe(
            &[
                used(
                    "2026-09-02T02:00:00Z",
                    horizon(32.0),
                    Some("exposure-share-v1"),
                ),
                used("2026-08-05T00:00:00Z", percentile.clone(), None),
                used(
                    "2026-09-02T20:00:00Z",
                    horizon(24.0),
                    Some("exposure-share-v1"),
                ),
                used(
                    "2026-09-03T18:00:00Z",
                    profit_per_day.clone(),
                    Some("exposure-share-v1"),
                ),
                used(
                    "2026-09-05T17:00:00Z",
                    profit_per_day.clone(),
                    Some("pooled-supply-v1"),
                ),
                used("2026-09-06T00:00:00Z", updated, Some("pooled-supply-v1")),
                used("2026-09-10T00:00:00Z", seventy, Some("pooled-supply-v1")),
            ],
            "2026-08-10",
        );
        let expected = [
            (
                "2026-09-02",
                vec![
                    "Policy: Target horizon of 24 days",
                    "Pricing model exposure-share-v1",
                ],
            ),
            (
                "2026-09-03",
                vec!["Policy: Profit per day at a 0.50%/day hurdle"],
            ),
            ("2026-09-05", vec!["Pricing model pooled-supply-v1"]),
            (
                "2026-09-10",
                vec!["Product line settings (default 70th percentile)"],
            ),
        ];
        assert_eq!(
            changes,
            expected
                .map(|(day, changes)| PricingChange {
                    changed_on: day.into(),
                    changes: changes.into_iter().map(str::to_owned).collect()
                })
                .to_vec()
        );
        let early = describe(
            &[
                used("2026-09-02T00:00:00Z", percentile, None),
                used("2026-09-03T00:00:00Z", horizon(30.0), None),
            ],
            "2026-09-04",
        );
        assert!(
            early.is_empty(),
            "changes before the trend starts are left out"
        );
    }

    #[test]
    fn labels_read_as_the_node_app_writes_them() {
        assert_eq!(format_days(7.46), "7.5 days");
        assert_eq!(format_days(24.0), "24 days");
        assert_eq!(format_days(1234.4), "1,234 days");
        assert_eq!(format_hurdle(0.005), "0.50%/day");
        assert_eq!(
            [1.0, 2.0, 3.0, 4.0, 11.0, 12.0, 13.0, 21.0, 65.0, 112.0].map(format_percentile),
            [
                "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "65th", "112th"
            ]
        );
    }
}
