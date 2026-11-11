//! The share of buyers the store wins once every competing ask is weighed by its price, its copies
//! and its seller's quality, instead of by counting the sellers at or below the price
//! (`super::supply_analysis`). An ask's weight is
//! `quantity * exp(quality - sensitivity * ln(price / reference))`, the reference the curve's own
//! median sale price; the store's share is its weight over the sum of them all, and its median wait
//! is `ln 2 * buyer interval / share`, as the curve reads its own. The share is continuous in
//! price, so it can be read along a curve. Recorded beside the other sell-time forecasts to be
//! graded (`features::forecast_calibration`); pricing does not read it.
use serde::Serialize;

use super::policy::{Curve, median_sell_days};
use super::supply_analysis::Listing;

/// What the listings search says of an ask's seller; any of it may be missing.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SellerQuality {
    /// Positive feedback, a percentage.
    pub rating: Option<f64>,
    /// Sales the seller has completed.
    pub sales: Option<f64>,
    pub verified: Option<bool>,
}

/// How buyers weigh asks against each other.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    /// Names the fit, so stored forecasts from different fits stay apart.
    pub name: &'static str,
    /// How fast an ask's weight falls with its price: an ask at `r` times another's price weighs
    /// `r^-sensitivity` as much.
    pub price_sensitivity: f64,
    pub rating_weight: f64,
    pub sales_weight: f64,
    pub verified_weight: f64,
    /// The store's own quality, which its asks do not report to it.
    pub store_quality: f64,
}

/// Feedback at or below this percentage scores nothing; 100% scores fully.
pub const RATING_FLOOR: f64 = 90.0;
/// Sales at which the sales term saturates; the search writes larger counts as `10000+`.
pub const SALES_SATURATION: f64 = 10_000.0;
/// What a term scores when an ask does not report it: halfway, neither good nor bad.
pub const UNREPORTED: f64 = 0.5;

/// Provisional, not fitted: no seller quality has been stored yet to fit on with the cohort method
/// the buyer-choice calibration used. Round values chosen to be moderate: an ask 10% dearer weighs
/// about a third less, and the best seller outweighs the worst at the same price about four and a
/// half times. The store scores as a seller that reports nothing, so asks that report nothing
/// compete with it on price and copies alone.
pub const CALIBRATION: Calibration = Calibration {
    name: "quality-share-provisional-v1",
    price_sensitivity: 4.0,
    rating_weight: 0.5,
    sales_weight: 0.5,
    verified_weight: 0.5,
    store_quality: 0.75,
};

/// A seller's quality: each term scored from 0 to 1, saturating, weighted and summed. A term the
/// ask does not report scores [`UNREPORTED`].
pub fn quality(seller: &SellerQuality, calibration: &Calibration) -> f64 {
    let reported = |v: Option<f64>| v.filter(|v| v.is_finite());
    let rating = reported(seller.rating).map_or(UNREPORTED, |rating| {
        ((rating - RATING_FLOOR) / (100.0 - RATING_FLOOR)).clamp(0.0, 1.0)
    });
    let sales = reported(seller.sales).map_or(UNREPORTED, |sales| {
        (sales.max(0.0).ln_1p() / SALES_SATURATION.ln_1p()).min(1.0)
    });
    let verified = seller
        .verified
        .map_or(UNREPORTED, |verified| if verified { 1.0 } else { 0.0 });
    calibration.rating_weight * rating
        + calibration.sales_weight * sales
        + calibration.verified_weight * verified
}

/// The log of one copy's weight at `price`.
fn log_weight(price: f64, quality: f64, reference: f64, calibration: &Calibration) -> f64 {
    quality - calibration.price_sensitivity * (price / reference).ln()
}

fn positive(value: f64) -> bool {
    value.is_finite() && value > 0.0
}

/// The share of buyers one copy at `listed_price` wins against `asks`, each at its delivered
/// price in the listed condition's terms; none for a price or reference that is not one. An ask
/// without a quantity offers one copy, and one without a price or copies is not weighed.
pub fn store_win_share(
    listed_price: f64,
    asks: &[Listing],
    reference: f64,
    calibration: &Calibration,
) -> Option<f64> {
    if !(positive(listed_price) && positive(reference)) {
        return None;
    }
    let store = log_weight(
        listed_price,
        calibration.store_quality,
        reference,
        calibration,
    );
    // Each ask's weight over the store's, so no weight overflows on its own.
    let competing: f64 = asks
        .iter()
        .filter_map(|ask| {
            let (price, copies) = (ask.delivered(), ask.quantity.unwrap_or(1.0));
            (positive(price) && positive(copies)).then(|| {
                let quality = quality(&ask.seller_quality, calibration);
                copies * (log_weight(price, quality, reference, calibration) - store).exp()
            })
        })
        .sum();
    Some(1.0 / (1.0 + competing))
}

/// The quality-aware forecast of one modeled result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forecast {
    pub calibration: &'static str,
    /// The curve's median sale price, every ask's price read against it.
    pub reference_price: f64,
    /// Asks observed competing with the store's.
    pub competing_asks: usize,
    pub store_win_share: f64,
    /// Days between buyers paying at least the listed price, as the curve reads them.
    pub buyer_interval_days: f64,
    pub median_sell_days: f64,
}

/// The forecast for a copy listed at `listed_price` on `curve` against the observed `asks`,
/// when the curve has a median price and buyers arrive at the listed price.
pub fn forecast(
    curve: &Curve,
    listed_price: f64,
    buyer_interval_days: Option<f64>,
    asks: &[Listing],
    calibration: Calibration,
) -> Option<Forecast> {
    let buyer_interval_days = buyer_interval_days.filter(|days| positive(*days))?;
    let reference_price = curve.median_price()?;
    let store_win_share = store_win_share(listed_price, asks, reference_price, &calibration)?;
    Some(Forecast {
        calibration: calibration.name,
        reference_price,
        competing_asks: asks.len(),
        store_win_share,
        buyer_interval_days,
        median_sell_days: median_sell_days(Some(buyer_interval_days), Some(store_win_share), None)?,
    })
}

#[cfg(test)]
mod tests {
    use std::f64::consts::LN_2;

    use super::super::policy::CurvePoint;
    use super::*;

    fn ask(price: f64, quantity: Option<f64>, seller_quality: SellerQuality) -> Listing {
        Listing {
            condition: "Near Mint".into(),
            price,
            quantity,
            seller_quality,
            ..Listing::default()
        }
    }

    fn unreported(price: f64) -> Listing {
        ask(price, None, SellerQuality::default())
    }

    fn share(listed_price: f64, asks: &[Listing]) -> f64 {
        store_win_share(listed_price, asks, 10.0, &CALIBRATION).unwrap()
    }

    const BEST: SellerQuality = SellerQuality {
        rating: Some(100.0),
        sales: Some(50_000.0),
        verified: Some(true),
    };
    const WORST: SellerQuality = SellerQuality {
        rating: Some(80.0),
        sales: Some(0.0),
        verified: Some(false),
    };

    #[test]
    fn the_share_is_continuous_in_price() {
        let asks = [unreported(9.0), unreported(10.0), unreported(12.0)];
        // Crossing a competitor's price moves the share by as little as the price moved.
        let (below, above) = (share(9.999, &asks), share(10.001, &asks));
        assert!(below > above, "{below} vs {above}");
        assert!(below - above < 1e-3, "{below} vs {above}");
        // Dearer always wins less, and alone the store wins every buyer.
        let shares: Vec<f64> = [5.0, 8.0, 10.0, 14.0, 20.0]
            .map(|price| share(price, &asks))
            .to_vec();
        assert!(shares.windows(2).all(|w| w[1] < w[0]), "{shares:?}");
        assert_eq!(share(10.0, &[]), 1.0);
    }

    #[test]
    fn better_competitors_win_more_of_the_buyers() {
        let against = |seller| share(10.0, &[ask(10.0, None, seller)]);
        let (best, unknown, worst) = (
            against(BEST),
            against(SellerQuality::default()),
            against(WORST),
        );
        assert!(
            best < unknown && unknown < worst,
            "{best} {unknown} {worst}"
        );
        // At the same price, the best seller outweighs the store by its quality over the store's.
        let expected =
            1.0 / (1.0 + (quality(&BEST, &CALIBRATION) - CALIBRATION.store_quality).exp());
        assert!((best - expected).abs() < 1e-12);
        // Each term saturates: past the cap, more sales are no better.
        let more = SellerQuality {
            sales: Some(1_000_000.0),
            ..BEST
        };
        assert_eq!(quality(&more, &CALIBRATION), quality(&BEST, &CALIBRATION));
        assert_eq!(quality(&BEST, &CALIBRATION), 1.5);
        assert_eq!(quality(&WORST, &CALIBRATION), 0.0);
    }

    #[test]
    fn copies_weigh_as_separate_asks() {
        let three = share(10.0, &[ask(11.0, Some(3.0), BEST)]);
        let one_each: Vec<Listing> = (0..3).map(|_| ask(11.0, None, BEST)).collect();
        let one_each = share(10.0, &one_each);
        assert!((three - one_each).abs() < 1e-12);
        assert_eq!(
            share(10.0, &[ask(11.0, Some(1.0), BEST)]),
            share(10.0, &[ask(11.0, None, BEST)])
        );
        // An ask with no copies or no price is not weighed.
        assert_eq!(
            share(10.0, &[ask(11.0, Some(0.0), BEST), unreported(0.0)]),
            1.0
        );
    }

    #[test]
    fn unreported_quality_competes_as_the_store_does() {
        assert_eq!(
            quality(&SellerQuality::default(), &CALIBRATION),
            CALIBRATION.store_quality
        );
        // An ask reporting nothing splits buyers evenly with the store at the same price.
        assert!((share(10.0, &[unreported(10.0)]) - 0.5).abs() < 1e-12);
        // A term not reported, or not a number, lies between its best and worst.
        let rated = |rating| SellerQuality {
            rating,
            ..SellerQuality::default()
        };
        let partial = quality(&rated(None), &CALIBRATION);
        assert_eq!(quality(&rated(Some(f64::NAN)), &CALIBRATION), partial);
        assert!(quality(&rated(Some(100.0)), &CALIBRATION) > partial);
        assert!(quality(&rated(Some(85.0)), &CALIBRATION) < partial);
        assert_eq!(store_win_share(0.0, &[], 10.0, &CALIBRATION), None);
        assert_eq!(store_win_share(10.0, &[], f64::NAN, &CALIBRATION), None);
    }

    fn point(percentile: f64, price: f64) -> CurvePoint {
        CurvePoint {
            percentile,
            price,
            ..CurvePoint::default()
        }
    }

    #[test]
    fn the_forecast_waits_for_its_share_of_the_buyers_at_the_price() {
        let curve = Curve::new(vec![point(5.0, 6.0), point(50.0, 8.0), point(95.0, 12.0)]);
        let asks = [ask(9.0, Some(2.0), BEST), unreported(7.5)];
        let forecast = forecast(&curve, 9.0, Some(3.0), &asks, CALIBRATION).unwrap();
        assert_eq!(forecast.calibration, "quality-share-provisional-v1");
        assert_eq!(forecast.reference_price, 8.0);
        assert_eq!(forecast.competing_asks, 2);
        let expected = store_win_share(9.0, &asks, 8.0, &CALIBRATION).unwrap();
        assert_eq!(forecast.store_win_share, expected);
        assert!((forecast.median_sell_days - LN_2 * 3.0 / expected).abs() < 1e-9);
        // The reference scales every weight alike, so the share does not depend on it.
        let elsewhere = store_win_share(9.0, &asks, 80.0, &CALIBRATION).unwrap();
        assert!((elsewhere - expected).abs() < 1e-12);
        // No buyers, or no curve to read a reference from, forecast nothing.
        assert_eq!(super::forecast(&curve, 9.0, None, &asks, CALIBRATION), None);
        assert_eq!(
            super::forecast(&curve, 9.0, Some(0.0), &asks, CALIBRATION),
            None
        );
        assert_eq!(
            super::forecast(&Curve::new(Vec::new()), 9.0, Some(3.0), &asks, CALIBRATION),
            None
        );
    }
}
