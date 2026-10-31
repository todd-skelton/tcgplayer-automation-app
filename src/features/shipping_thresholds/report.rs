//! The shipping threshold report (`loadShippingThresholdReport`): the shipping costs learned
//! from the seller's recent orders, what one more unit costs to ship one cent under each threshold
//! and at it, and what snapping did over the outcome window.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use super::{
    ShippingTier,
    cost_model::{self, MINIMUM_NEARBY_BASKETS},
    evidence,
    outcomes::{self, Outcome},
};
use crate::{
    database::Database,
    features::{
        configuration::config::Snaps, inventory_economics::ledger::assumptions::js_round,
        shipping_configuration,
    },
};

/// The snap settings the report was read under.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub thresholds: Vec<f64>,
    pub snap_range: f64,
    pub evidence_window_days: u32,
}

/// The learned cost model, its baskets counted rather than listed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostModel {
    pub learned_at: String,
    pub evidence_window_days: i64,
    pub order_count: usize,
    pub tiers: Vec<ShippingTier>,
    pub basket_count: usize,
}

/// Expected shipping cost per unit one cent under a threshold and at it; neither when too few
/// sold nearby to snap.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdCost {
    pub threshold: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snap_price_shipping_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold_shipping_cost: Option<f64>,
    /// Units sold between half and twice the threshold; snaps need at least the minimum.
    pub basket_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingReport {
    pub seller_key: String,
    pub settings: Settings,
    pub cost_model: CostModel,
    pub threshold_costs: Vec<ThresholdCost>,
    pub outcome_window_days: u32,
    pub outcomes: Vec<Outcome>,
}

/// `thresholdShippingCosts`, in the settings' order.
fn threshold_costs(
    model: &super::ShippingCostModel,
    thresholds: &[f64],
    overhead_rate: f64,
) -> Vec<ThresholdCost> {
    thresholds
        .iter()
        .map(|&threshold| {
            let baskets = cost_model::baskets_near(model, threshold);
            let cost = |price: f64| {
                (baskets.len() >= MINIMUM_NEARBY_BASKETS).then(|| {
                    let cost = cost_model::expected_shipping_cost(
                        &model.tiers,
                        &baskets,
                        price,
                        overhead_rate,
                    );
                    js_round(cost * 100.0) as f64 / 100.0
                })
            };
            ThresholdCost {
                threshold,
                snap_price_shipping_cost: cost(threshold - 0.01),
                threshold_shipping_cost: cost(threshold),
                basket_count: baskets.len(),
            }
        })
        .collect()
}

/// The report over the trailing `outcome_window_days`, read at `now` under the snap settings
/// and the profit-per-day overhead; why not when no shipping seller is set.
pub async fn load(
    db: &Database,
    snaps: &Snaps,
    overhead_rate: f64,
    outcome_window_days: u32,
    now: DateTime<Utc>,
) -> Result<ShippingReport, String> {
    let e = |e: sqlx::Error| e.to_string();
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(e)?;
    let seller = seller.trim();
    if seller.is_empty() {
        return Err("Set the default seller in shipping export settings.".into());
    }
    let since = now - Duration::days(i64::from(outcome_window_days));
    let (model, orders, publications) = tokio::try_join!(
        evidence::learn_recent(db, seller, i64::from(snaps.evidence_window_days), now),
        evidence::shipped_orders(db, seller, since),
        evidence::snap_publications(db, seller, since)
    )
    .map_err(e)?;
    let thresholds: Vec<f64> = snaps.thresholds.iter().map(|t| f64::from(*t)).collect();
    Ok(ShippingReport {
        seller_key: seller.to_owned(),
        settings: Settings {
            enabled: snaps.enabled,
            thresholds: thresholds.clone(),
            snap_range: snaps.snap_range,
            evidence_window_days: snaps.evidence_window_days,
        },
        threshold_costs: threshold_costs(&model, &thresholds, overhead_rate),
        outcomes: outcomes::outcomes(
            &thresholds,
            snaps.snap_range,
            overhead_rate,
            &orders,
            &publications,
        ),
        cost_model: CostModel {
            learned_at: model.learned_at,
            evidence_window_days: model.evidence_window_days,
            order_count: model.order_count,
            basket_count: model.baskets.len(),
            tiers: model.tiers,
        },
        outcome_window_days,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::features::configuration::config;

    /// Every number as a float, so `2` and `2.0` compare equal.
    fn floats(value: Value) -> Value {
        match value {
            Value::Number(n) => serde_json::json!(n.as_f64()),
            Value::Array(items) => Value::Array(items.into_iter().map(floats).collect()),
            Value::Object(fields) => {
                Value::Object(fields.into_iter().map(|(k, v)| (k, floats(v))).collect())
            }
            other => other,
        }
    }

    /// Node's reports over each outcome window at one time, on the dev database
    /// (`.port-logs/shipping-thresholds-node.ts`): the same, figure for figure.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's reports in .port-logs"]
    async fn reports_read_as_node_reads_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/shipping-thresholds.node.json").unwrap(),
        )
        .unwrap();
        let now: DateTime<Utc> = node["at"].as_str().unwrap().parse().unwrap();
        let stored = config::load(&db).await.unwrap();
        for days in config::EVIDENCE_WINDOWS {
            let theirs = &node[days.to_string()];
            let ours = load(
                &db,
                &stored.snaps,
                stored.pricing.profit_per_day.relative_overhead,
                days,
                now,
            )
            .await;
            match ours {
                Ok(ours) => assert_eq!(
                    floats(serde_json::to_value(&ours).unwrap()),
                    floats(theirs.clone()),
                    "{days} days"
                ),
                Err(ours) => assert_eq!(ours, theirs["error"].as_str().unwrap_or_default()),
            }
        }
    }
}
