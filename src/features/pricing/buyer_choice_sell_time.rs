//! How long one listing takes to sell, from how buyers actually choose: the card's sale rate at
//! any price, softened by competing sellers, scaled by the card's share of what the buyer pays.
//! Ported from `buyerChoiceSellTime.ts`; the model has no within-card price response, so it is
//! read for one listing at its price, never along a curve.
use crate::js_math::JsMath;
use serde::Serialize;

use super::policy::CurvePoint;

/// A fitted model. Elasticities sit below one because part of every card's sales arrive through
/// the store, not through a price contest for that card.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    /// Names the fit, so stored forecasts from different fits stay apart.
    pub name: &'static str,
    /// Log daily sale rate at one sale a day, no competitors and no fixed cost.
    pub log_daily_rate: f64,
    pub demand_elasticity: f64,
    pub competition_elasticity: f64,
    pub effective_price_elasticity: f64,
    /// Dollars a buyer pays beyond the card, as the fit assumed.
    pub purchase_fixed_cost: f64,
}

/// Fitted on 1,196 listings priced 2026-08-11 to 13 against their sales over the next 21 days,
/// with the store's small-order shipping fee as the fixed cost of a purchase.
pub const CALIBRATION: Calibration = Calibration {
    name: "2026-08-11-cohort",
    log_daily_rate: -3.5172,
    demand_elasticity: 0.4478,
    competition_elasticity: 0.1997,
    effective_price_elasticity: 0.8246,
    purchase_fixed_cost: 1.49,
};

/// The store's shipping fee on a small order, which the fit assumed as a purchase's fixed cost.
pub const SMALL_ORDER_SHIPPING_FEE: f64 = 1.49;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Inputs {
    /// Days between the card's sales at the bottom of the curve, so at any price.
    pub buyer_interval_days: f64,
    /// Sellers competing anywhere on the curve.
    pub competing_sellers: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub median_sell_days: f64,
    pub calibration: &'static str,
}

/// The card facts the model was fitted on, read from a pricing curve.
pub fn inputs(curve: &[CurvePoint]) -> Option<Inputs> {
    let mut sorted: Vec<&CurvePoint> = curve.iter().collect();
    sorted.sort_by(|l, r| l.percentile.total_cmp(&r.percentile));
    let bottom = sorted
        .into_iter()
        .find(|p| p.buyer_interval_days.unwrap_or(0.0) > 0.0)?;
    let competing_sellers = curve
        .iter()
        .filter_map(|p| p.listings_count)
        .reduce(f64::max)?;
    Some(Inputs {
        buyer_interval_days: bottom.buyer_interval_days?,
        competing_sellers,
    })
}

/// Median days for one listing to sell, or none when an input is unusable.
pub fn sell_days(inputs: Inputs, listed_price: f64, calibration: Calibration) -> Option<f64> {
    let Inputs {
        buyer_interval_days,
        competing_sellers,
    } = inputs;
    if !(buyer_interval_days.is_finite() && buyer_interval_days > 0.0)
        || !(competing_sellers.is_finite() && competing_sellers >= 0.0)
        || !(listed_price.is_finite() && listed_price > 0.0)
    {
        return None;
    }
    let log_rate = calibration.log_daily_rate
        - calibration.demand_elasticity * buyer_interval_days.js_ln()
        - calibration.competition_elasticity * (competing_sellers + 1.0).js_ln()
        + calibration.effective_price_elasticity
            * (listed_price / (listed_price + calibration.purchase_fixed_cost)).js_ln();
    Some(std::f64::consts::LN_2 / log_rate.js_exp())
}

/// The forecast for a listing at its price, when its curve supports one.
pub fn forecast(
    curve: &[CurvePoint],
    listed_price: f64,
    calibration: Calibration,
) -> Option<Forecast> {
    let median_sell_days = sell_days(inputs(curve)?, listed_price, calibration)?;
    Some(Forecast {
        median_sell_days,
        calibration: calibration.name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(interval: f64, sellers: f64, price: f64) -> Option<f64> {
        sell_days(
            Inputs {
                buyer_interval_days: interval,
                competing_sellers: sellers,
            },
            price,
            CALIBRATION,
        )
    }

    #[test]
    fn the_fit_assumed_the_small_order_shipping_fee() {
        assert_eq!(CALIBRATION.purchase_fixed_cost, SMALL_ORDER_SHIPPING_FEE);
    }

    #[test]
    fn demand_competition_and_effective_price_slow_a_sale() {
        let baseline = days(1.0, 0.0, 1_000_000.0).unwrap();
        assert!(days(4.0, 0.0, 1_000_000.0).unwrap() > baseline);
        assert!(days(1.0, 20.0, 1_000_000.0).unwrap() > baseline);
        assert!(days(1.0, 0.0, 0.3).unwrap() > days(1.0, 0.0, 30.0).unwrap());
        assert!(days(1.0, 20.0, 1_000_000.0).unwrap() < days(4.0, 20.0, 1_000_000.0).unwrap());
        assert_eq!(days(0.0, 0.0, 1_000_000.0), None);
        assert_eq!(days(1.0, f64::NAN, 1_000_000.0), None);
        assert_eq!(days(1.0, 0.0, 0.0), None);
    }

    #[test]
    fn zero_elasticities_leave_the_base_rate() {
        let flat = Calibration {
            demand_elasticity: 0.0,
            competition_elasticity: 0.0,
            effective_price_elasticity: 0.0,
            ..CALIBRATION
        };
        let d = sell_days(
            Inputs {
                buyer_interval_days: 2.0,
                competing_sellers: 9.0,
            },
            5.0,
            flat,
        )
        .unwrap();
        assert!((d - std::f64::consts::LN_2 / CALIBRATION.log_daily_rate.js_exp()).abs() < 1e-9);
    }

    fn point(
        percentile: f64,
        price: f64,
        interval: Option<f64>,
        listings: Option<f64>,
    ) -> CurvePoint {
        CurvePoint {
            percentile,
            price,
            buyer_interval_days: interval,
            listings_count: listings,
            ..CurvePoint::default()
        }
    }

    #[test]
    fn inputs_come_from_the_lowest_point_with_an_interval_and_the_most_sellers() {
        let curve = [
            point(50.0, 12.0, Some(3.0), Some(7.0)),
            point(5.0, 8.0, None, Some(0.0)),
            point(10.0, 9.0, Some(0.5), Some(1.0)),
        ];
        assert_eq!(
            inputs(&curve),
            Some(Inputs {
                buyer_interval_days: 0.5,
                competing_sellers: 7.0
            })
        );
        assert_eq!(inputs(&[point(5.0, 8.0, Some(2.0), None)]), None);
        assert_eq!(inputs(&[point(5.0, 8.0, None, Some(3.0))]), None);
        assert_eq!(
            forecast(&curve, 12.0, CALIBRATION),
            Some(Forecast {
                median_sell_days: days(0.5, 7.0, 12.0).unwrap(),
                calibration: "2026-08-11-cohort"
            })
        );
        assert_eq!(forecast(&[], 12.0, CALIBRATION), None);
    }
}
