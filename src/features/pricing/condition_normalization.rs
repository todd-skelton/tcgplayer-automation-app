//! Sales of every condition of a card expressed in the listed condition's terms: a time-aware
//! fit of price against condition rank when the sales support one, else the card's value ladder
//! from its sibling SKUs' market prices, else no scaling. Ported from
//! `conditionNormalization.ts`.
use serde::Serialize;

use super::{
    buyer_arrival_rate::{LATEST_SALES_HISTORY_DAYS, LATEST_SALES_LIMIT},
    sale::Sale,
};

/// The graded conditions, best first, as sales and listings name them.
pub const CONDITIONS: [&str; 5] = [
    "Near Mint",
    "Lightly Played",
    "Moderately Played",
    "Heavily Played",
    "Damaged",
];
const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const MODEL_PARAMETER_COUNT: usize = 3;
const MINIMUM_OBSERVATIONS_PER_CONDITION: usize = 2;
const MINIMUM_RESIDUAL_DEGREES_OF_FREEDOM: usize = 2;
/// The fitted exponent's cap of 2 spans at most 5^2 between the extreme conditions.
const SIBLING_RATIO_LIMIT: f64 = 25.0;

/// A graded condition's place, 0 for Near Mint; none for any other (Unopened, unknown).
pub fn rank(condition: &str) -> Option<usize> {
    CONDITIONS.iter().position(|c| *c == condition)
}

/// One multiplier per condition, in [`CONDITIONS`] order.
pub type Multipliers = [f64; 5];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Method {
    TimeControlledZipf,
    SiblingMarketRatio,
    NeutralConditionFallback,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub method: Method,
    pub observation_count: usize,
    pub observed_condition_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_exponent: Option<f64>,
    /// The condition whose market price stood in for the listed one's, when they differ.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_condition: Option<&'static str>,
    pub condition_time_connected: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub as_of: Option<f64>,
    /// Latest market price of each condition of the same product, variant and language.
    pub sibling_market_prices: [Option<f64>; 5],
}

#[derive(Clone, Copy, Debug)]
struct Observation {
    /// 1 for Near Mint.
    rank: f64,
    price: f64,
    timestamp: f64,
}

fn solve(mut matrix: [[f64; 4]; 3]) -> Option<[f64; 3]> {
    let n = 3;
    for column in 0..n {
        let mut pivot = column;
        for row in column + 1..n {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-10 {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in &mut matrix[column][column..] {
            *value /= divisor;
        }
        let pivot_row = matrix[column];
        for (row, values) in matrix.iter_mut().enumerate() {
            if row == column {
                continue;
            }
            let factor = values[column];
            for (value, pivot_value) in values[column..].iter_mut().zip(&pivot_row[column..]) {
                *value -= factor * pivot_value;
            }
        }
    }
    Some([matrix[0][3], matrix[1][3], matrix[2][3]])
}

/// What condition explains beyond time: the residual of log rank against a line in time.
fn condition_information(observations: &[Observation]) -> f64 {
    if observations.len() < 2 {
        return 0.0;
    }
    let times: Vec<f64> = observations
        .iter()
        .map(|o| o.timestamp / MILLISECONDS_PER_DAY)
        .collect();
    let conditions: Vec<f64> = observations.iter().map(|o| o.rank.ln()).collect();
    let len = times.len() as f64;
    let mean_time = times.iter().fold(0.0, |t, v| t + v) / len;
    let mean_condition = conditions.iter().fold(0.0, |t, v| t + v) / len;
    let time_variance = times.iter().fold(0.0, |t, v| t + (v - mean_time).powi(2));
    let covariance = times.iter().zip(&conditions).fold(0.0, |t, (time, c)| {
        t + (time - mean_time) * (c - mean_condition)
    });
    let slope = if time_variance > 0.0 {
        covariance / time_variance
    } else {
        0.0
    };
    conditions.iter().zip(&times).fold(0.0, |t, (c, time)| {
        let expected = mean_condition + slope * (time - mean_time);
        t + (c - expected).powi(2)
    })
}

/// Whether every condition's span of sale times overlaps, through the others, every other's.
fn timelines_connected(observations: &[Observation]) -> bool {
    let mut ranges: Vec<(f64, f64, f64)> = Vec::new();
    for o in observations {
        match ranges.iter_mut().find(|(rank, ..)| *rank == o.rank) {
            Some((_, min, max)) => {
                *min = min.min(o.timestamp);
                *max = max.max(o.timestamp);
            }
            None => ranges.push((o.rank, o.timestamp, o.timestamp)),
        }
    }
    if ranges.len() < 2 {
        return false;
    }
    let mut connected = vec![false; ranges.len()];
    connected[0] = true;
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..ranges.len() {
            if connected[i] {
                continue;
            }
            let (_, min, max) = ranges[i];
            let overlaps = (0..ranges.len())
                .filter(|&j| connected[j])
                .any(|j| min <= ranges[j].2 && ranges[j].1 <= max);
            if overlaps {
                connected[i] = true;
                changed = true;
            }
        }
    }
    connected.iter().all(|c| *c)
}

fn for_exponent(exponent: f64, target: usize) -> Multipliers {
    let target_rank = (target + 1) as f64;
    std::array::from_fn(|i| ((i + 1) as f64 / target_rank).powf(exponent))
}

fn priced(prices: &[Option<f64>; 5], i: usize) -> Option<f64> {
    prices[i].filter(|p| *p > 0.0)
}

/// The closest better condition with a market price, else the closest worse.
fn nearest_priced(prices: &[Option<f64>; 5], condition: usize) -> Option<usize> {
    (0..condition)
        .rev()
        .find(|&i| priced(prices, i).is_some())
        .or_else(|| (condition + 1..5).find(|&i| priced(prices, i).is_some()))
}

/// One value per condition for the whole card: an unpriced condition takes its nearest priced
/// neighbour's, no condition is valued above a better one, and every value is bounded to the
/// fitted exponent's reach below Near Mint's.
fn value_ladder(prices: &[Option<f64>; 5]) -> Option<([f64; 5], [Option<usize>; 5])> {
    let mut values = [0.0; 5];
    let mut anchors = [None; 5];
    let mut ceiling = f64::INFINITY;
    for condition in 0..5 {
        let value = match priced(prices, condition) {
            Some(own) => own,
            None => {
                let neighbour = nearest_priced(prices, condition)?;
                anchors[condition] = Some(neighbour);
                prices[neighbour]?
            }
        };
        let value = value.min(ceiling);
        values[condition] = value;
        ceiling = value;
    }
    let best = values[0];
    for value in &mut values {
        *value = value.max(best / SIBLING_RATIO_LIMIT);
    }
    Some((values, anchors))
}

/// Each condition scaled onto the target by the card's value ladder.
fn sibling_ratio(prices: &[Option<f64>; 5], target: usize) -> Option<(Multipliers, Option<usize>)> {
    let (values, anchors) = value_ladder(prices)?;
    let target_value = values[target];
    Some((
        std::array::from_fn(|i| target_value / values[i]),
        anchors[target],
    ))
}

/// `fitTimeAwareZipfModelToConditions`.
pub fn fit(
    sales: &[Sale],
    target: usize,
    options: &Options,
    now: f64,
) -> (Multipliers, Diagnostics) {
    let as_of = options.as_of.unwrap_or(now);
    let oldest = as_of - LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY;
    let mut candidates: Vec<Observation> = sales
        .iter()
        .filter_map(|sale| {
            let rank = rank(&sale.condition)?;
            let price = sale.effective_price();
            let timestamp = sale.timestamp();
            (price > 0.0 && timestamp.is_finite()).then_some(Observation {
                rank: (rank + 1) as f64,
                price,
                timestamp,
            })
        })
        .filter(|o| o.timestamp >= oldest && o.timestamp <= as_of)
        .collect();
    candidates.sort_by(|l, r| r.timestamp.total_cmp(&l.timestamp));
    candidates.truncate(LATEST_SALES_LIMIT);
    let mut per_condition = [0usize; 6];
    for o in &candidates {
        per_condition[o.rank as usize] += 1;
    }
    let observations: Vec<Observation> = candidates
        .into_iter()
        .filter(|o| per_condition[o.rank as usize] >= MINIMUM_OBSERVATIONS_PER_CONDITION)
        .collect();
    let condition_count = per_condition
        .iter()
        .filter(|c| **c >= MINIMUM_OBSERVATIONS_PER_CONDITION)
        .count();
    let information = condition_information(&observations);
    let connected = timelines_connected(&observations);
    let diagnostics = |method, condition_exponent, anchor_condition| Diagnostics {
        method,
        observation_count: observations.len(),
        observed_condition_count: condition_count,
        condition_exponent,
        anchor_condition,
        condition_time_connected: connected,
    };
    let fallback = || match sibling_ratio(&options.sibling_market_prices, target) {
        Some((multipliers, anchor)) => (
            multipliers,
            diagnostics(
                Method::SiblingMarketRatio,
                None,
                anchor.map(|a| CONDITIONS[a]),
            ),
        ),
        None => (
            for_exponent(0.0, target),
            diagnostics(Method::NeutralConditionFallback, Some(0.0), None),
        ),
    };
    if observations.len() < MODEL_PARAMETER_COUNT + MINIMUM_RESIDUAL_DEGREES_OF_FREEDOM
        || condition_count < 2
        || information < 1e-6
        || !connected
    {
        return fallback();
    }
    let features: Vec<[f64; 3]> = observations
        .iter()
        .map(|o| {
            [
                1.0,
                (o.timestamp - as_of) / (LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY),
                o.rank.ln(),
            ]
        })
        .collect();
    let log_prices: Vec<f64> = observations.iter().map(|o| o.price.ln()).collect();
    let mut weights = vec![1.0; observations.len()];
    let mut coefficients = None;
    for _ in 0..4 {
        let mut system = [[0.0; 4]; 3];
        for (row, feature) in features.iter().enumerate() {
            for left in 0..3 {
                system[left][3] += weights[row] * feature[left] * log_prices[row];
                for right in 0..3 {
                    system[left][right] += weights[row] * feature[left] * feature[right];
                }
            }
        }
        coefficients = solve(system);
        let Some(c) = coefficients else { break };
        let residuals: Vec<f64> = features
            .iter()
            .zip(&log_prices)
            .map(|(row, log_price)| log_price - row.iter().zip(&c).fold(0.0, |t, (v, k)| t + v * k))
            .collect();
        let mut absolute: Vec<f64> = residuals.iter().map(|r| r.abs()).collect();
        absolute.sort_by(f64::total_cmp);
        let median = absolute[absolute.len() / 2];
        let scale = (if median == 0.0 || median.is_nan() {
            0.01
        } else {
            median
        }) * 1.4826;
        weights = residuals
            .iter()
            .map(|r| 1.0_f64.min((1.345 * scale) / r.abs().max(1e-10)))
            .collect();
    }
    let Some(c) = coefficients else {
        return fallback();
    };
    let exponent = 0.0_f64.max(2.0_f64.min(-c[2]));
    (
        for_exponent(exponent, target),
        diagnostics(Method::TimeControlledZipf, Some(exponent), None),
    )
}

/// The multiplier a condition's sales take: 1 for a condition outside the graded ones.
pub fn multiplier(multipliers: Option<&Multipliers>, condition: &str) -> f64 {
    match (multipliers, rank(condition)) {
        (Some(m), Some(r)) => m[r],
        _ => 1.0,
    }
}

/// A sale in the target condition's terms.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Normalized {
    pub price: f64,
    pub quantity: f64,
    pub timestamp: f64,
}

pub fn normalize_sales(sales: &[Sale], multipliers: Option<&Multipliers>) -> Vec<Normalized> {
    sales
        .iter()
        .map(|sale| Normalized {
            price: sale.effective_price() * multiplier(multipliers, &sale.condition),
            quantity: if sale.quantity == 0.0 || sale.quantity.is_nan() {
                1.0
            } else {
                sale.quantity
            },
            timestamp: sale.timestamp(),
        })
        .collect()
}

/// The delivered ask above which no listing of the product competes at any condition's curve
/// price: the highest sale in Near Mint's terms, anchored to the newest sale and rounded up to
/// the cent, so every SKU of the product computes the same number.
pub fn competing_ask_ceiling(sales: &[Sale], options: &Options) -> Option<f64> {
    let newest = sales
        .iter()
        .map(Sale::timestamp)
        .filter(|t| t.is_finite())
        .reduce(f64::max)?;
    let options = Options {
        as_of: Some(options.as_of.unwrap_or(newest)),
        ..options.clone()
    };
    let (multipliers, _) = fit(sales, 0, &options, newest);
    let highest = normalize_sales(sales, Some(&multipliers))
        .iter()
        .map(|n| n.price)
        .fold(f64::NEG_INFINITY, f64::max);
    Some((highest * 100.0).ceil() / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AS_OF: f64 = 1_788_220_800_000.0; // 2026-09-01T00:00:00Z
    const NM: usize = 0;
    const LP: usize = 1;
    const MP: usize = 2;
    const HP: usize = 3;
    const DMG: usize = 4;

    fn sale(condition: &str, price: f64, days_ago: f64) -> Sale {
        Sale {
            condition: condition.into(),
            quantity: 1.0,
            purchase_price: price,
            order_date: chrono::DateTime::from_timestamp_millis(
                (AS_OF - days_ago * 86_400_000.0) as i64,
            )
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string(),
            ..Sale::default()
        }
    }

    fn single_condition() -> Vec<Sale> {
        vec![
            sale("Near Mint", 11.0, 1.0),
            sale("Near Mint", 11.5, 3.0),
            sale("Near Mint", 10.8, 6.0),
            sale("Near Mint", 11.2, 9.0),
        ]
    }

    const PRICES: [Option<f64>; 5] = [Some(11.32), Some(10.63), Some(10.25), None, Some(9.24)];

    fn fitted(target: usize, prices: [Option<f64>; 5]) -> (Multipliers, Diagnostics) {
        fit(
            &single_condition(),
            target,
            &Options {
                as_of: Some(AS_OF),
                sibling_market_prices: prices,
            },
            AS_OF,
        )
    }

    fn round(v: f64) -> f64 {
        (v * 1000.0).round() / 1000.0
    }

    #[test]
    fn an_unpriced_condition_is_valued_as_the_nearest_better_one() {
        let (m, d) = fitted(HP, PRICES);
        assert_eq!(d.method, Method::SiblingMarketRatio);
        assert_eq!(d.anchor_condition, Some("Moderately Played"));
        assert_eq!(
            m.map(round),
            [
                round(10.25 / 11.32),
                round(10.25 / 10.63),
                1.0,
                1.0,
                round(10.25 / 9.24)
            ]
        );
        let (m, d) = fitted(NM, [None, Some(10.63), Some(10.25), None, None]);
        assert_eq!(d.anchor_condition, Some("Lightly Played"));
        assert_eq!(m[LP], 1.0);
        assert_eq!(round(m[MP]), round(10.63 / 10.25));
        let (m, d) = fitted(LP, PRICES);
        assert_eq!(d.anchor_condition, None);
        assert_eq!(round(m[NM]), round(10.63 / 11.32));
    }

    #[test]
    fn every_condition_shares_one_ladder_and_none_is_above_a_better_one() {
        let ladders: Vec<Multipliers> = (0..5).map(|t| fitted(t, PRICES).0).collect();
        for other in 0..5 {
            for ladder in &ladders {
                let ratio = ladder[other] / ladders[0][other] / (ladder[NM] / ladders[0][NM]);
                assert!((ratio - 1.0).abs() < 1e-9);
            }
        }
        let inverted = [Some(11.38), None, Some(10.25), None, Some(12.0)];
        assert_eq!(fitted(HP, inverted).0[DMG], 1.0);
        assert_eq!(round(fitted(NM, inverted).0[DMG]), round(11.38 / 10.25));
        let (m, d) = fitted(HP, [None; 5]);
        assert_eq!(d.method, Method::NeutralConditionFallback);
        assert_eq!(m[NM], 1.0);
    }

    #[test]
    fn the_listings_cap_is_the_highest_sale_in_near_mint_terms() {
        let options = Options {
            as_of: Some(AS_OF),
            sibling_market_prices: PRICES,
        };
        let mut sales = single_condition();
        sales.push(sale("Damaged", 9.0, 2.0));
        assert_eq!(
            competing_ask_ceiling(&sales, &options).map(round),
            Some(11.5)
        );
        assert_eq!(
            competing_ask_ceiling(
                &[sale("Damaged", 9.0, 2.0), sale("Near Mint", 9.5, 1.0)],
                &options
            ),
            Some((9.0 * (11.32 / 9.24) * 100.0_f64).ceil() / 100.0)
        );
        assert_eq!(competing_ask_ceiling(&[], &options), None);
        let unanchored = Options {
            as_of: None,
            sibling_market_prices: PRICES,
        };
        let earlier = Options {
            as_of: Some(AS_OF - 86_400_000.0),
            sibling_market_prices: PRICES,
        };
        assert_eq!(
            competing_ask_ceiling(&sales, &unanchored),
            competing_ask_ceiling(&sales, &earlier)
        );
    }

    #[test]
    fn sales_in_two_conditions_fit_an_exponent() {
        let mut sales = Vec::new();
        for d in 0..10 {
            sales.push(sale("Near Mint", 10.0, d as f64 * 3.0));
            sales.push(sale("Moderately Played", 7.0, d as f64 * 3.0 + 1.0));
        }
        let (m, d) = fit(
            &sales,
            NM,
            &Options {
                as_of: Some(AS_OF),
                ..Options::default()
            },
            AS_OF,
        );
        assert_eq!(d.method, Method::TimeControlledZipf);
        assert!((m[MP] - 10.0 / 7.0).abs() < 0.05, "{m:?}");
    }
}
