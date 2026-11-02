//! Whole cents split across weighted targets, exactly and in a fixed order.
use super::fingerprint::js_float;

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
/// Most callers in the Node app weigh by whole numbers (units, cents, or 1 each); a frozen market
/// weighs by market value, which [`allocate_weighted`] splits by. The arithmetic is exact in
/// `i128`.
pub fn allocate(total_cents: i64, targets: &[(&str, u64)]) -> Option<Vec<Share>> {
    let targets: Vec<(&str, i128)> = targets
        .iter()
        .map(|(id, w)| (*id, i128::from(*w)))
        .collect();
    split(total_cents, &targets)
}

/// `allocateAmountCents` by JavaScript numbers, each read as exactly the decimal it prints as
/// (`decimalNumberAsInteger`) and all brought to one scale, so `0.1 * 3` weighs
/// `0.30000000000000004`. Refused in Node's words when a weight is negative or not a number, or
/// none is positive; refused too when the scaled weights pass what `i128` holds, where Node's
/// `BigInt` would go on (no market value the app stores comes near).
pub fn allocate_weighted(total_cents: i64, targets: &[(&str, f64)]) -> Result<Vec<Share>, String> {
    let mut exact = Vec::with_capacity(targets.len());
    for (id, weight) in targets {
        if !weight.is_finite() || *weight < 0.0 {
            return Err(format!(
                "Allocation weight for {} must be nonnegative.",
                id.trim()
            ));
        }
        exact.push(decimal(*weight));
    }
    let too_large = || "Allocation weights are too large to split exactly.".to_owned();
    let scale = exact.iter().flatten().map(|(_, s)| *s).max().unwrap_or(0);
    let mut scaled = Vec::with_capacity(targets.len());
    let mut sum: i128 = 0;
    for ((id, _), weight) in targets.iter().zip(exact) {
        let (integer, own) = weight.ok_or_else(too_large)?;
        let weight = 10_i128
            .checked_pow(scale - own)
            .and_then(|factor| integer.checked_mul(factor))
            .ok_or_else(too_large)?;
        sum = sum.checked_add(weight).ok_or_else(too_large)?;
        scaled.push((*id, weight));
    }
    sum.checked_mul(i128::from(total_cents).abs())
        .ok_or_else(too_large)?;
    split(total_cents, &scaled)
        .ok_or_else(|| "Allocation weights must include a positive value.".to_owned())
}

/// `decimalNumberAsInteger`: `value` as JavaScript prints it, an integer and how many of its
/// digits are decimals (`12.5` is 125 at scale 1, `1e+21` is 10^21 at scale 0).
fn decimal(value: f64) -> Option<(i128, u32)> {
    let printed = js_float(value).to_lowercase();
    let (coefficient, exponent) = printed.split_once('e').unwrap_or((&printed, "0"));
    let exponent: i64 = exponent.parse().ok()?;
    let (whole, fraction) = coefficient.split_once('.').unwrap_or((coefficient, ""));
    let integer: i128 = format!("{whole}{fraction}").parse().ok()?;
    let scale = i64::try_from(fraction.len()).ok()? - exponent;
    if scale >= 0 {
        Some((integer, u32::try_from(scale).ok()?))
    } else {
        Some((
            integer.checked_mul(10_i128.checked_pow(u32::try_from(-scale).ok()?)?)?,
            0,
        ))
    }
}

/// The split itself, by whole weights (`i128`, nonnegative).
fn split(total_cents: i64, targets: &[(&str, i128)]) -> Option<Vec<Share>> {
    if total_cents < 0 {
        let shares = split(total_cents.checked_neg()?, targets)?;
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
    let total_weight: i128 = targets.iter().map(|(_, w)| *w).sum();
    if total_weight == 0 {
        return None;
    }
    let total = i128::from(total_cents);
    let mut shares: Vec<(String, i128, i128)> = targets
        .iter()
        .map(|(id, weight)| {
            let numerator = total * *weight;
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

    /// Node: `allocateAmountCents(1000, [{id:"1",weight:1.25*2},{id:"2",weight:0.1*3},{id:"3",weight:1.5}])`
    /// is `[{id:"1",amountCents:581},{id:"2",amountCents:70},{id:"3",amountCents:349}]`.
    #[test]
    fn decimal_weights_split_as_node_splits_them() {
        let shares =
            allocate_weighted(1000, &[("1", 1.25 * 2.0), ("2", 0.1 * 3.0), ("3", 1.5)]).unwrap();
        assert_eq!(cents(&shares), [("1", 581), ("2", 70), ("3", 349)]);
        assert_eq!(decimal(0.1 * 3.0), Some((30_000_000_000_000_004, 17)));
        assert_eq!(decimal(1e21), Some((1_000_000_000_000_000_000_000, 0)));
        assert_eq!(decimal(1e-7), Some((1, 7)));
        assert_eq!(
            allocate_weighted(10, &[("a", 0.0)]),
            Err("Allocation weights must include a positive value.".to_owned())
        );
        assert_eq!(
            allocate_weighted(10, &[("a", -1.0)]),
            Err("Allocation weight for a must be nonnegative.".to_owned())
        );
    }

    #[test]
    fn nothing_to_split_across_is_refused() {
        assert_eq!(allocate(10, &[]), None);
        assert_eq!(allocate(10, &[("a", 0)]), None);
        assert_eq!(allocate(10, &[("a", 1), (" a ", 1)]), None);
    }
}
