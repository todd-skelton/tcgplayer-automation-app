//! What stands in for missing order evidence. Strategy needs a general sense of proceeds and
//! cost, not audited financials, so each gap is filled with what is normally true and labeled
//! estimated instead of holding the order back.
use serde_json::Value;

/// The first-class letter rate assumed when the seller has bought no postage yet.
pub const DEFAULT_POSTAGE_CENTS: i64 = 78;

/// What the refund records say about an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refund {
    None,
    Known(i64),
    Unknown,
}

/// Reads refund records as the Seller Portal reports them: no records at all is no refund
/// (its status is often empty), and an amount that is not a whole number of cents is unknown.
pub fn refund_evidence(refunds: &Value) -> Refund {
    let Some(refunds) = refunds.as_array() else {
        return Refund::Unknown;
    };
    if refunds.is_empty() {
        return Refund::None;
    }
    let mut total = 0;
    for refund in refunds {
        let Some(amount) = refund.get("amount").and_then(Value::as_f64) else {
            return Refund::Unknown;
        };
        let cents = (amount * 100.0).round();
        if !amount.is_finite()
            || amount < 0.0
            || (amount * 100.0 - cents).abs() > 1e-7
            || cents > 9.0e15
        {
            return Refund::Unknown;
        }
        total += cents as i64;
    }
    Refund::Known(total)
}

/// How a refund settlement relates to the order's net: a reduction of it, or already in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementBasis {
    OriginalNetRefundAdjustment,
    AlreadyAdjustedNet,
}

/// A settlement assumed for a refund with none recorded: the refund takes the share of net
/// proceeds it took of the gross order, so fees count as refunded in proportion. A canceled
/// order keeps nothing. Every assumed settlement is estimated.
pub fn assume_refund_settlement(
    canceled: bool,
    refund_gross_cents: i64,
    gross_order_cents: Option<i64>,
    provider_net_cents: Option<i64>,
) -> (i64, SettlementBasis) {
    if canceled {
        return (0, SettlementBasis::AlreadyAdjustedNet);
    }
    match (gross_order_cents, provider_net_cents) {
        (Some(gross), Some(net)) if gross > 0 => {
            let share = (refund_gross_cents as f64 / gross as f64).min(1.0);
            (
                js_round(net as f64 * share),
                SettlementBasis::OriginalNetRefundAdjustment,
            )
        }
        _ => (
            refund_gross_cents,
            SettlementBasis::OriginalNetRefundAdjustment,
        ),
    }
}

/// Postage assumed for an order without a bought label: the median of what the seller paid for
/// the others, or the default rate when there are none.
pub fn assume_postage_cents(known: impl IntoIterator<Item = i64>) -> i64 {
    let mut sorted: Vec<i64> = known.into_iter().filter(|c| *c >= 0).collect();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    match sorted.len() {
        0 => DEFAULT_POSTAGE_CENTS,
        n if n % 2 == 1 => sorted[middle],
        _ => js_round((sorted[middle - 1] + sorted[middle]) as f64 / 2.0),
    }
}

/// `Math.round`: halves round up, toward positive infinity, as the Node app rounds.
pub fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_refund_settlement_and_postage_evidence_is_filled_in() {
        assert_eq!(refund_evidence(&json!([])), Refund::None);
        assert_eq!(refund_evidence(&Value::Null), Refund::Unknown);
        assert_eq!(
            refund_evidence(&json!([{ "amount": 1.5 }, { "amount": 2 }])),
            Refund::Known(350)
        );
        assert_eq!(
            refund_evidence(&json!([{ "amount": "1.5" }])),
            Refund::Unknown
        );

        use SettlementBasis::*;
        assert_eq!(
            assume_refund_settlement(true, 1000, Some(1000), Some(870)),
            (0, AlreadyAdjustedNet)
        );
        assert_eq!(
            assume_refund_settlement(false, 250, Some(1000), Some(870)),
            (218, OriginalNetRefundAdjustment)
        );
        assert_eq!(
            assume_refund_settlement(false, 250, None, None),
            (250, OriginalNetRefundAdjustment)
        );

        assert_eq!(assume_postage_cents([]), 78);
        assert_eq!(assume_postage_cents([120, 73, 78]), 78);
        assert_eq!(assume_postage_cents([73, 78, 120, 400]), 99);
    }

    #[test]
    fn rounding_matches_the_node_app() {
        assert_eq!(js_round(2.5), 3);
        assert_eq!(js_round(-2.5), -2);
        assert_eq!(js_round(217.5), 218);
    }
}
