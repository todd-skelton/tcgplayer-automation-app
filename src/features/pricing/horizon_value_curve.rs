//! Portfolio value against target horizon as a log-logistic curve: `horizonValueCurve.ts`.
//! value = floor + (ceiling - floor) / (1 + (midpointDays / horizonDays) ^ steepness).
use crate::js_math::JsMath;
use serde::{Deserialize, Serialize};

/// Residual is the root-mean-square error in headroom fraction over the samples the curve was
/// fitted from.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HorizonValueCurve {
    pub floor_value: f64,
    pub ceiling_value: f64,
    pub midpoint_days: f64,
    pub steepness: f64,
    pub residual: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HorizonValueSample {
    pub horizon_days: f64,
    pub value: f64,
}

/// Where the curve rises and how sharply, without the values it rises between.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HorizonShape {
    pub midpoint_days: f64,
    pub steepness: f64,
}

/// Headroom odds at the knee. On the log-horizon axis the logistic gain decelerates fastest where
/// captured / remaining headroom equals 2 + sqrt(3), about 79% of headroom captured.
fn knee_headroom_odds() -> f64 {
    2.0 + 3f64.sqrt()
}
/// Greater than zero, and so not NaN.
fn positive(value: f64) -> bool {
    value > 0.0
}

const SATURATION_LIMIT: f64 = 1e-3;
const MINIMUM_FIT_SAMPLES: usize = 3;

/// Horizons spaced evenly in log space from minimum to maximum, endpoints exact.
pub fn log_spaced_horizons(minimum_days: f64, maximum_days: f64, count: usize) -> Vec<f64> {
    let last = count.saturating_sub(1);
    (0..count)
        .map(|index| match index {
            0 => minimum_days,
            i if i == last => maximum_days,
            i => minimum_days * (maximum_days / minimum_days).powf(i as f64 / last as f64),
        })
        .collect()
}

impl HorizonShape {
    pub fn headroom_fraction(&self, horizon_days: f64) -> f64 {
        if !positive(horizon_days) {
            return 0.0;
        }
        let offset = self.steepness * (horizon_days.js_ln() - self.midpoint_days.js_ln());
        1.0 / (1.0 + (-offset).js_exp())
    }

    /// Horizon at which gain per doubling of horizon decelerates fastest.
    pub fn knee_days(&self) -> f64 {
        self.midpoint_days * knee_headroom_odds().powf(1.0 / self.steepness)
    }
}

impl HorizonValueCurve {
    pub fn shape(&self) -> HorizonShape {
        HorizonShape {
            midpoint_days: self.midpoint_days,
            steepness: self.steepness,
        }
    }

    pub fn headroom_fraction(&self, horizon_days: f64) -> f64 {
        self.shape().headroom_fraction(horizon_days)
    }

    pub fn value(&self, horizon_days: f64) -> f64 {
        self.floor_value
            + (self.ceiling_value - self.floor_value) * self.headroom_fraction(horizon_days)
    }

    /// Dollars gained per additional day of horizon.
    pub fn marginal_value_per_day(&self, horizon_days: f64) -> f64 {
        if !positive(horizon_days) {
            return 0.0;
        }
        let fraction = self.headroom_fraction(horizon_days);
        ((self.ceiling_value - self.floor_value) * fraction * (1.0 - fraction) * self.steepness)
            / horizon_days
    }

    /// Percent change in gain over floor per percent change in horizon. Starts at the steepness
    /// for short horizons and falls toward zero as value saturates.
    pub fn gain_elasticity(&self, horizon_days: f64) -> f64 {
        self.steepness * (1.0 - self.headroom_fraction(horizon_days))
    }

    pub fn knee_days(&self) -> f64 {
        self.shape().knee_days()
    }
}

/// Fits midpoint and steepness by weighted least squares of the headroom logit against log
/// horizon. Floor and ceiling are the exact values with every SKU pinned at its fastest and
/// slowest curve point, so they are inputs rather than fitted coefficients. Saturated samples
/// carry no slope information and are left out of the regression but counted in the residual,
/// which is the root-mean-square error in headroom fraction.
pub fn fit(
    samples: &[HorizonValueSample],
    floor_value: f64,
    ceiling_value: f64,
) -> Option<HorizonValueCurve> {
    let headroom = ceiling_value - floor_value;
    if !positive(headroom) {
        return None;
    }
    let points: Vec<(f64, f64)> = samples
        .iter()
        .filter(|s| s.horizon_days > 0.0 && s.horizon_days.is_finite() && s.value.is_finite())
        .map(|s| (s.horizon_days, (s.value - floor_value) / headroom))
        .collect();
    let interior: Vec<&(f64, f64)> = points
        .iter()
        .filter(|(_, fraction)| *fraction > SATURATION_LIMIT && *fraction < 1.0 - SATURATION_LIMIT)
        .collect();
    if interior.len() < MINIMUM_FIT_SAMPLES {
        return None;
    }

    let (mut weight_sum, mut weighted_x, mut weighted_y, mut weighted_xx, mut weighted_xy) =
        (0.0, 0.0, 0.0, 0.0, 0.0);
    for &&(horizon_days, fraction) in &interior {
        let log_horizon = horizon_days.js_ln();
        let weight = fraction * (1.0 - fraction);
        let logit = (fraction / (1.0 - fraction)).js_ln();
        weight_sum += weight;
        weighted_x += weight * log_horizon;
        weighted_y += weight * logit;
        weighted_xx += weight * log_horizon * log_horizon;
        weighted_xy += weight * log_horizon * logit;
    }
    let denominator = weight_sum * weighted_xx - weighted_x * weighted_x;
    if !positive(denominator) {
        return None;
    }
    let steepness = (weight_sum * weighted_xy - weighted_x * weighted_y) / denominator;
    let midpoint_days = (-(weighted_y - steepness * weighted_x) / weight_sum / steepness).js_exp();
    if !positive(steepness) || !positive(midpoint_days) || !midpoint_days.is_finite() {
        return None;
    }

    let shape = HorizonShape {
        midpoint_days,
        steepness,
    };
    let squared_error = points.iter().fold(0.0, |sum, &(horizon_days, fraction)| {
        let error = shape.headroom_fraction(horizon_days) - fraction;
        sum + error * error
    });
    Some(HorizonValueCurve {
        floor_value,
        ceiling_value,
        midpoint_days,
        steepness,
        residual: (squared_error / points.len() as f64).sqrt(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: HorizonValueCurve = HorizonValueCurve {
        floor_value: 100.0,
        ceiling_value: 500.0,
        midpoint_days: 30.0,
        steepness: 1.5,
        residual: 0.0,
    };

    fn sampled(value: impl Fn(f64) -> f64) -> Vec<HorizonValueSample> {
        (0..25)
            .map(|index| {
                let horizon_days = (0.5f64.js_ln()
                    + ((2000f64.js_ln() - 0.5f64.js_ln()) * index as f64) / 24.0)
                    .js_exp();
                HorizonValueSample {
                    horizon_days,
                    value: value(horizon_days),
                }
            })
            .collect()
    }

    #[test]
    fn fits_and_evaluates_in_closed_form() {
        let spaced = log_spaced_horizons(10.0, 33.5, 24);
        assert_eq!(spaced.len(), 24);
        assert_eq!(spaced[0], 10.0, "the first horizon is exactly the minimum");
        assert_eq!(spaced[23], 33.5, "the last horizon is exactly the maximum");
        assert!(spaced.windows(2).all(|w| w[1] > w[0]));

        let fitted = fit(
            &sampled(|h| KNOWN.value(h)),
            KNOWN.floor_value,
            KNOWN.ceiling_value,
        )
        .unwrap();
        assert!(
            (fitted.midpoint_days - KNOWN.midpoint_days).abs() < 1e-6,
            "the fit recovers the midpoint"
        );
        assert!(
            (fitted.steepness - KNOWN.steepness).abs() < 1e-6,
            "the fit recovers the steepness"
        );
        assert!(fitted.residual < 1e-9);

        assert_eq!(KNOWN.value(KNOWN.midpoint_days), 300.0);
        assert!(
            (KNOWN.headroom_fraction(KNOWN.knee_days()) - 0.7887).abs() < 1e-3,
            "the knee sits where roughly 79% of headroom is captured"
        );
        assert!((KNOWN.knee_days() - 30.0 * (2.0 + 3f64.sqrt()).powf(1.0 / 1.5)).abs() < 1e-9);
        assert!(
            (KNOWN.gain_elasticity(KNOWN.midpoint_days) - 0.75).abs() < 1e-9,
            "elasticity at the midpoint is half the steepness"
        );
        let numeric_slope = (KNOWN.value(30.001) - KNOWN.value(29.999)) / 0.002;
        assert!(
            (numeric_slope - KNOWN.marginal_value_per_day(30.0)).abs() < 1e-4,
            "the marginal formula matches the numeric slope"
        );

        let at = |horizon_days, value| HorizonValueSample {
            horizon_days,
            value,
        };
        assert_eq!(
            fit(&[at(1.0, 5.0)], 5.0, 5.0),
            None,
            "no headroom means no curve"
        );
        assert_eq!(
            fit(
                &[at(1.0, 100.0), at(10.0, 300.0), at(100.0, 500.0)],
                100.0,
                500.0
            ),
            None,
            "saturated samples do not count toward the minimum interior samples"
        );
        assert_eq!(
            fit(&sampled(|h| 600.0 - KNOWN.value(h)), 100.0, 500.0),
            None,
            "a falling curve has no positive steepness"
        );

        let fast_movers = HorizonValueCurve {
            floor_value: 0.0,
            ceiling_value: 200.0,
            midpoint_days: 3.0,
            ..KNOWN
        };
        let slow_movers = HorizonValueCurve {
            midpoint_days: 300.0,
            ..fast_movers
        };
        let two_clusters = fit(
            &sampled(|h| 100.0 + fast_movers.value(h) + slow_movers.value(h)),
            100.0,
            500.0,
        )
        .unwrap();
        assert!(
            two_clusters.residual > 0.05,
            "fast and slow clusters far apart report a visibly worse fit"
        );
    }
}
