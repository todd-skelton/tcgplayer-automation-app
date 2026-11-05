//! The argument that maximizes a score: `maximize.ts`.

const GOLDEN_RATIO: f64 = 0.618_033_988_749_894_9;
const REFINEMENT_ITERATIONS: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Maximum {
    pub argument: f64,
    pub value: f64,
}

/// Every candidate is scored first so a score with more than one peak cannot trap the search,
/// then golden-section search sharpens the answer between the neighbours of the best candidate.
/// The best candidate itself is kept when refinement cannot beat it, so an optimum on a candidate
/// is returned exactly. None when there are no candidates or any score is not a number.
pub fn maximize_over_candidates(candidates: &[f64], score: impl Fn(f64) -> f64) -> Option<Maximum> {
    let scores: Vec<f64> = candidates.iter().map(|&c| score(c)).collect();
    if scores.iter().any(|s| s.is_nan()) {
        return None;
    }
    let top = scores.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let best_index = scores.iter().position(|&s| s == top)?;
    let best = Maximum {
        argument: candidates[best_index],
        value: scores[best_index],
    };

    let mut low = candidates[best_index.saturating_sub(1)];
    let mut high = candidates[(best_index + 1).min(candidates.len() - 1)];
    if low == high {
        return Some(best);
    }
    let mut lower = high - GOLDEN_RATIO * (high - low);
    let mut upper = low + GOLDEN_RATIO * (high - low);
    let mut lower_score = score(lower);
    let mut upper_score = score(upper);
    for _ in 0..REFINEMENT_ITERATIONS {
        if lower_score < upper_score {
            low = lower;
            lower = upper;
            lower_score = upper_score;
            upper = low + GOLDEN_RATIO * (high - low);
            upper_score = score(upper);
        } else {
            high = upper;
            upper = lower;
            upper_score = lower_score;
            lower = high - GOLDEN_RATIO * (high - low);
            lower_score = score(lower);
        }
    }
    let refined = (low + high) / 2.0;
    let refined_score = score(refined);
    Some(if refined_score > best.value {
        Maximum {
            argument: refined,
            value: refined_score,
        }
    } else {
        best
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_candidates_and_sharpens_the_best_stretch() {
        assert_eq!(GOLDEN_RATIO, (5f64.sqrt() - 1.0) / 2.0);
        let grid: Vec<f64> = (0..11).map(f64::from).collect();
        let interior = maximize_over_candidates(&grid, |x| -((x - 3.3).powi(2))).unwrap();
        assert!(
            (interior.argument - 3.3).abs() < 1e-4,
            "refinement finds the peak between candidates"
        );
        assert_eq!(
            maximize_over_candidates(&grid, |x| x).unwrap().argument,
            10.0,
            "a peak on the last candidate is returned exactly"
        );
        let two_peaks = maximize_over_candidates(&grid, |x| {
            (-((x - 1.0).powi(2))).exp() + 2.0 * (-((x - 8.0).powi(2))).exp()
        })
        .unwrap();
        assert!(
            (two_peaks.argument - 8.0).abs() < 1e-4,
            "scanning first keeps the search out of the lower peak"
        );
        assert_eq!(
            maximize_over_candidates(&[4.0], |x| x * 2.0),
            Some(Maximum {
                argument: 4.0,
                value: 8.0
            })
        );
        assert_eq!(maximize_over_candidates(&[], |x| x), None);
        assert_eq!(maximize_over_candidates(&[1.0, 2.0], |_| f64::NAN), None);
    }
}
