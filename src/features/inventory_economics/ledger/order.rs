//! One order's economics: what it brought in after fees, refunds, postage and other expenses,
//! what its stock cost, and how much of that is known, estimated, or missing.
use serde::Serialize;

use super::assumptions::SettlementBasis;

/// How much of a figure is known: from records, assumed, or not at all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Coverage {
    Actual,
    Estimated,
    #[default]
    Unknown,
}

impl std::fmt::Display for Coverage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Coverage::Actual => "actual",
            Coverage::Estimated => "estimated",
            Coverage::Unknown => "unknown",
        })
    }
}

/// Whether a figure came from a record or was assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    Actual,
    Estimated,
}

/// What the refund records say, for an order's economics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundState {
    None,
    Known,
    Unknown,
}

/// A refund's settlement: how much, from a record or assumed, and how it relates to the net.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub cents: i64,
    pub provenance: Provenance,
    pub basis: SettlementBasis,
}

/// What is known about an order, as `calculateOrderEconomics` takes it.
#[derive(Clone, Debug)]
pub struct Evidence {
    pub order_number: String,
    pub currency: String,
    pub canceled: bool,
    pub ordered_quantity: i64,
    pub settled_quantity: i64,
    pub cost_known_quantity: i64,
    pub gross_item_cents: i64,
    pub gross_shipping_cents: Option<i64>,
    pub gross_order_cents: Option<i64>,
    pub platform_fee_cents: Option<i64>,
    pub provider_net_cents: Option<i64>,
    pub direct_fee_cents: Option<i64>,
    pub refund: RefundState,
    pub settlement: Option<Settlement>,
    pub postage_cents: Option<i64>,
    pub postage_coverage: Coverage,
    pub expense_evidence_complete: bool,
    pub other_expenses: Vec<(i64, Provenance)>,
    pub acquisition_cost_cents: Option<i64>,
    pub acquisition_cost_coverage: Coverage,
}

/// An order's economics, as the screens and the strategy read them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderEconomics {
    pub order_number: String,
    pub currency: String,
    pub gross_order_cents: Option<i64>,
    pub provider_net_cents: Option<i64>,
    pub postage_cents: Option<i64>,
    pub other_expense_cents: i64,
    pub acquisition_cost_cents: Option<i64>,
    /// What the order left to buy more stock with; none while any of it is unknown.
    pub reusable_cash_cents: Option<i64>,
    pub realized_profit_cents: Option<i64>,
    pub proceeds_coverage: Coverage,
    pub expense_coverage: Coverage,
    pub cost_coverage: Coverage,
    /// What is missing for the figures to be known, in words.
    pub missing: Vec<&'static str>,
    pub ordered_quantity: i64,
    pub settled_quantity: i64,
    pub cost_known_quantity: i64,
}

pub fn calculate(e: &Evidence) -> OrderEconomics {
    let mut missing = Vec::new();
    let transaction_known = match (
        e.gross_shipping_cents,
        e.gross_order_cents,
        e.platform_fee_cents,
        e.provider_net_cents,
    ) {
        (Some(shipping), Some(gross), Some(fee), Some(net)) => {
            e.gross_item_cents + shipping == gross && gross - fee == net
        }
        _ => false,
    };
    if !transaction_known {
        missing.push("verified provider transaction totals");
    }
    let direct_fee = e.direct_fee_cents.unwrap_or(0) != 0;
    if direct_fee {
        missing.push("nonzero direct-fee semantics");
    }
    if e.refund == RefundState::Unknown {
        missing.push("complete refund amounts");
    }
    let refunded = e.refund == RefundState::Known;
    let unsettled = refunded && e.settlement.is_none();
    if unsettled {
        missing.push("verified refund settlement or fee credit");
    }
    if e.postage_coverage == Coverage::Unknown {
        missing.push("postage expense");
    }
    if !e.expense_evidence_complete {
        missing.push("complete order expense history");
    }
    if e.acquisition_cost_coverage == Coverage::Unknown {
        missing.push("acquisition cost");
    }
    let final_net = e
        .settlement
        .is_some_and(|s| s.basis == SettlementBasis::AlreadyAdjustedNet);
    if e.canceled && !final_net {
        missing.push("verified final sale settlement");
    }

    let estimated_expense = e.postage_coverage == Coverage::Estimated
        || e.other_expenses
            .iter()
            .any(|(_, p)| *p == Provenance::Estimated)
        || e.settlement
            .is_some_and(|s| s.provenance == Provenance::Estimated);
    let expense_coverage = if e.postage_coverage == Coverage::Unknown
        || !e.expense_evidence_complete
        || e.refund == RefundState::Unknown
        || unsettled
    {
        Coverage::Unknown
    } else if estimated_expense {
        Coverage::Estimated
    } else {
        Coverage::Actual
    };
    let proceeds_coverage = if !transaction_known
        || direct_fee
        || e.refund == RefundState::Unknown
        || unsettled
        || (e.canceled && !final_net)
    {
        Coverage::Unknown
    } else if e
        .settlement
        .is_some_and(|s| s.provenance == Provenance::Estimated)
    {
        Coverage::Estimated
    } else {
        Coverage::Actual
    };

    let other_expense_cents: i64 = e.other_expenses.iter().map(|(c, _)| c).sum();
    let reusable_cash_cents = (proceeds_coverage != Coverage::Unknown
        && expense_coverage != Coverage::Unknown)
        .then(|| {
            let (base, adjustment) = match e.settlement {
                Some(s) if s.basis == SettlementBasis::AlreadyAdjustedNet => (s.cents, 0),
                Some(s) => (e.provider_net_cents.unwrap_or(0), s.cents),
                None => (e.provider_net_cents.unwrap_or(0), 0),
            };
            base - adjustment - e.postage_cents.unwrap_or(0) - other_expense_cents
        });
    let realized_profit_cents = reusable_cash_cents
        .filter(|_| e.acquisition_cost_coverage != Coverage::Unknown)
        .map(|cash| cash - e.acquisition_cost_cents.unwrap_or(0));

    OrderEconomics {
        order_number: e.order_number.clone(),
        currency: e.currency.clone(),
        gross_order_cents: e.gross_order_cents,
        provider_net_cents: e.provider_net_cents,
        postage_cents: e.postage_cents,
        other_expense_cents,
        acquisition_cost_cents: e.acquisition_cost_cents,
        reusable_cash_cents,
        realized_profit_cents,
        proceeds_coverage,
        expense_coverage,
        cost_coverage: e.acquisition_cost_coverage,
        missing,
        ordered_quantity: e.ordered_quantity,
        settled_quantity: e.settled_quantity,
        cost_known_quantity: e.cost_known_quantity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> Evidence {
        Evidence {
            order_number: "SYNTHETIC-ORDER".into(),
            currency: "USD".into(),
            canceled: false,
            ordered_quantity: 2,
            settled_quantity: 2,
            cost_known_quantity: 2,
            gross_item_cents: 10_000,
            gross_shipping_cents: Some(500),
            gross_order_cents: Some(10_500),
            platform_fee_cents: Some(1_000),
            provider_net_cents: Some(9_500),
            direct_fee_cents: Some(0),
            refund: RefundState::None,
            settlement: None,
            postage_cents: None,
            postage_coverage: Coverage::Actual,
            expense_evidence_complete: true,
            other_expenses: Vec::new(),
            acquisition_cost_cents: Some(3_000),
            acquisition_cost_coverage: Coverage::Actual,
        }
    }

    fn settled(cents: i64, provenance: Provenance, basis: SettlementBasis) -> Option<Settlement> {
        Some(Settlement {
            cents,
            provenance,
            basis,
        })
    }

    #[test]
    fn reusable_proceeds_keep_their_coverage_and_settled_quantities() {
        use SettlementBasis::*;
        let partial = calculate(&Evidence {
            refund: RefundState::Known,
            settlement: settled(1_800, Provenance::Actual, OriginalNetRefundAdjustment),
            postage_cents: Some(500),
            ..complete()
        });
        assert_eq!(
            (partial.reusable_cash_cents, partial.realized_profit_cents),
            (Some(7_200), Some(4_200))
        );

        let unsettled = calculate(&Evidence {
            refund: RefundState::Known,
            acquisition_cost_cents: None,
            acquisition_cost_coverage: Coverage::Unknown,
            ..complete()
        });
        assert_eq!(unsettled.reusable_cash_cents, None);
        assert!(unsettled.missing.join(" ").contains("refund settlement"));

        let adjusted = calculate(&Evidence {
            refund: RefundState::Known,
            settlement: settled(7_700, Provenance::Actual, AlreadyAdjustedNet),
            postage_cents: Some(500),
            acquisition_cost_cents: None,
            acquisition_cost_coverage: Coverage::Unknown,
            ..complete()
        });
        assert_eq!(adjusted.reusable_cash_cents, Some(7_200));

        let incomplete = calculate(&Evidence {
            refund: RefundState::Unknown,
            ..complete()
        });
        assert_eq!(incomplete.reusable_cash_cents, None);
        assert_eq!(incomplete.proceeds_coverage, Coverage::Unknown);
        assert!(
            incomplete
                .missing
                .join(" ")
                .contains("complete refund amounts")
        );

        let canceled = calculate(&Evidence {
            canceled: true,
            ..complete()
        });
        assert_eq!(canceled.reusable_cash_cents, None);
        assert!(canceled.missing.join(" ").contains("final sale settlement"));
        let assumed = calculate(&Evidence {
            canceled: true,
            settlement: settled(0, Provenance::Estimated, AlreadyAdjustedNet),
            ..complete()
        });
        assert_eq!(assumed.reusable_cash_cents, Some(0));
        assert_eq!(assumed.proceeds_coverage, Coverage::Estimated);

        let partial_cost = calculate(&Evidence {
            settled_quantity: 1,
            cost_known_quantity: 1,
            acquisition_cost_cents: None,
            acquisition_cost_coverage: Coverage::Unknown,
            ..complete()
        });
        assert_eq!(partial_cost.realized_profit_cents, None);
        assert_eq!(
            (
                partial_cost.ordered_quantity,
                partial_cost.settled_quantity,
                partial_cost.cost_known_quantity
            ),
            (2, 1, 1)
        );
    }
}
