//! Whole cents split across weighted targets, exactly and in a fixed order.

/// A share of an amount: who gets it and how many cents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Share {
    pub id: String,
    pub cents: i64,
}

/// Splits `total_cents` across `targets` (an id and a whole weight each) so the shares add up
/// to the total exactly. Each share is its weight's part rounded down; the cents left over go to
/// the largest remainders, then by id. A negative total is split by its size and keeps its sign.
/// The shares come back sorted by id. `None` when there is no target, an id repeats or is blank,
/// or every weight is zero.
///
/// Every caller in the Node app weighs by whole numbers (units, cents, or 1 each), so the
/// weights here are whole; the arithmetic is exact in `i128`.
pub fn allocate(total_cents: i64, targets: &[(&str, u64)]) -> Option<Vec<Share>> {
    if total_cents < 0 {
        let shares = allocate(total_cents.checked_neg()?, targets)?;
        return Some(
            shares
                .into_iter()
                .map(|s| Share {
                    cents: -s.cents,
                    ..s
                })
                .collect(),
        );
    }
    let mut ids: Vec<&str> = targets.iter().map(|(id, _)| id.trim()).collect();
    if ids.is_empty() || ids.iter().any(|id| id.is_empty()) {
        return None;
    }
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return None;
    }
    let total_weight: i128 = targets.iter().map(|(_, w)| i128::from(*w)).sum();
    if total_weight == 0 {
        return None;
    }
    let total = i128::from(total_cents);
    let mut shares: Vec<(String, i128, i128)> = targets
        .iter()
        .map(|(id, weight)| {
            let numerator = total * i128::from(*weight);
            (
                id.trim().to_owned(),
                numerator / total_weight,
                numerator % total_weight,
            )
        })
        .collect();
    let given: i128 = shares.iter().map(|(_, cents, _)| cents).sum();
    let mut order: Vec<usize> = (0..shares.len()).collect();
    order.sort_by(|&a, &b| {
        shares[b]
            .2
            .cmp(&shares[a].2)
            .then_with(|| shares[a].0.cmp(&shares[b].0))
    });
    let left = usize::try_from(total - given).ok()?;
    for index in 0..left {
        shares[order[index % order.len()]].1 += 1;
    }
    let mut out: Vec<Share> = shares
        .into_iter()
        .map(|(id, cents, _)| Share {
            id,
            cents: cents as i64,
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cents(shares: &[Share]) -> Vec<(&str, i64)> {
        shares.iter().map(|s| (s.id.as_str(), s.cents)).collect()
    }

    #[test]
    fn a_total_is_split_to_the_cent_in_a_fixed_order() {
        let shares =
            allocate(100, &[("receipt-2", 1), ("receipt-1", 1), ("receipt-3", 1)]).unwrap();
        assert_eq!(
            cents(&shares),
            [("receipt-1", 34), ("receipt-2", 33), ("receipt-3", 33)]
        );
        let negative = allocate(-33, &[("a", 2), ("b", 1)]).unwrap();
        assert_eq!(cents(&negative), [("a", -22), ("b", -11)]);
        let large = allocate(9_007_199_254_740_920, &[("a", 72), ("b", 3), ("c", 7)]).unwrap();
        assert_eq!(
            large.iter().map(|s| s.cents).sum::<i64>(),
            9_007_199_254_740_920
        );
    }

    #[test]
    fn nothing_to_split_across_is_refused() {
        assert_eq!(allocate(10, &[]), None);
        assert_eq!(allocate(10, &[("a", 0)]), None);
        assert_eq!(allocate(10, &[("a", 1), (" a ", 1)]), None);
    }
}
