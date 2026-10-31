//! The two reports the screen shows beside the settings they inform: how listings sold against
//! their sell-time forecasts (`features::forecast_calibration`), and what shipping costs at each
//! threshold and what snapping did. The shipping report's computation is still the Node app's
//! (`features/shipping-thresholds`); this reads its JSON route until that feature is ported.
use serde::Deserialize;

use crate::legacy::Legacy;

/// The days a report is read over, as its window select and links write it. None is the
/// report's default: 56 for the calibration, the snaps' evidence window for shipping.
#[derive(Clone, Copy, Debug, Default, Deserialize, corten::Route, corten::Fields)]
#[route(query)]
pub struct Window {
    pub days: Option<u32>,
}

impl Window {
    /// The days asked for when they are one of `windows`, else `default`: the Node routes refuse
    /// any other.
    pub fn days_in(self, windows: &[u32], default: u32) -> u32 {
        self.days
            .filter(|days| windows.contains(days))
            .unwrap_or(default)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Basis {
    Observed,
    Default,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tier {
    pub from_order_value: f64,
    pub order_count: f64,
    pub buyer_shipping: f64,
    pub postage: f64,
    pub basis: Basis,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostModel {
    pub evidence_window_days: f64,
    pub order_count: f64,
    pub basket_count: f64,
    pub tiers: Vec<Tier>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdCost {
    pub threshold: f64,
    pub basket_count: f64,
    /// None when too few sold nearby to snap.
    pub snap_price_shipping_cost: Option<f64>,
    pub threshold_shipping_cost: f64,
}

/// How a group of sales went; a share or mean is missing when there were none to take it from.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleGroup {
    pub units: f64,
    pub orders: f64,
    pub median_days_to_sell: Option<f64>,
    pub units_per_order: Option<f64>,
    pub orders_with_add_ons: Option<f64>,
    pub orders_reaching_threshold: Option<f64>,
    pub largest_order_units: f64,
    pub bulk_order_unit_share: Option<f64>,
    pub shipping_cost_per_order: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Listings {
    pub snapped: f64,
    pub kept: f64,
    pub floor: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub threshold: f64,
    pub snap_price: f64,
    pub listings: Listings,
    pub snapped: SaleGroup,
    pub kept: SaleGroup,
    pub just_above: SaleGroup,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shipping {
    pub cost_model: CostModel,
    pub threshold_costs: Vec<ThresholdCost>,
    pub outcomes: Vec<Outcome>,
}

pub async fn shipping(legacy: &Legacy, days: u32) -> Result<Shipping, String> {
    legacy
        .read(&format!("/api/shipping-thresholds?days={days}"))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the Node route answers, as captured from it.
    #[test]
    fn the_shipping_report_reads() {
        let json = r#"{"sellerKey":"k","settings":{},"outcomeWindowDays":90,
            "costModel":{"learnedAt":"2026-10-29T00:00:00Z","evidenceWindowDays":90,"orderCount":1220,"basketCount":3000,
                "tiers":[{"fromOrderValue":0,"buyerShipping":1.49,"postage":0.81,"orderCount":80,"postageOrderCount":80,"basis":"observed"}]},
            "thresholdCosts":[{"threshold":5,"basketCount":1138,"thresholdShippingCost":0.35}],
            "outcomes":[{"threshold":5,"snapPrice":4.99,"listings":{"snapped":0,"kept":0,"floor":0},
                "snapped":{"units":0,"orders":0,"largestOrderUnits":0},
                "kept":{"units":0,"orders":0,"largestOrderUnits":0},
                "justAbove":{"units":98,"orders":69,"unitsPerOrder":3.83,"ordersWithAddOns":0.507,"largestOrderUnits":15,"bulkOrderUnitShare":0.316,"shippingCostPerOrder":1.47}}]}"#;
        let report: Shipping = serde_json::from_str(json).unwrap();
        assert_eq!(report.threshold_costs[0].snap_price_shipping_cost, None);
        assert_eq!(report.outcomes[0].just_above.units_per_order, Some(3.83));
    }
}
