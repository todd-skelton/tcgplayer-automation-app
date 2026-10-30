//! Each order's economics from the evidence about it: shared expenses split over the orders they
//! name, each receipt's cost split over the orders that drew from it by units sold, postage from
//! bought labels or assumed, and refunds settled as recorded or assumed. The Node app's
//! `calculateInventoryEconomicsOrders`.
use std::collections::HashMap;

use super::{
    assumptions::{
        Refund, SettlementBasis, assume_postage_cents, assume_refund_settlement, refund_evidence,
    },
    evidence::{self, Evidence, ExpenseRow, OrderRow},
    fingerprint,
    money::allocate,
    order::{self, Coverage, OrderEconomics, Provenance, RefundState, Settlement},
    postage::{PostageEvidence, allocate_purchased_postage},
};

/// The share of a receipt's cost no order has drawn yet.
const REMAINING_INVENTORY: &str = "__remaining_inventory__";

/// Why a split could not be made, as the Node app refuses it.
const NO_TARGETS: &str = "At least one allocation target is required.";

/// An order expense's share for one order.
struct ExpenseShare<'a> {
    cents: i64,
    expense: &'a ExpenseRow,
}

/// Each order's shares of the expenses that name it, by currency and order number. A refund
/// settlement belongs whole to the first order it names; any other expense is split evenly.
fn allocate_shared_expenses(
    expenses: &[ExpenseRow],
) -> Result<HashMap<(String, String), Vec<ExpenseShare<'_>>>, String> {
    let mut by_order: HashMap<(String, String), Vec<ExpenseShare<'_>>> = HashMap::new();
    for expense in expenses {
        let mut orders: Vec<&str> = expense.order_numbers.iter().map(String::as_str).collect();
        orders.sort_unstable();
        orders.dedup();
        let shares: Vec<(String, i64)> = if expense.expense_type == "refund_settlement" {
            vec![(
                orders.first().copied().unwrap_or_default().to_owned(),
                expense.amount_cents,
            )]
        } else {
            let targets: Vec<(&str, u64)> = orders.iter().map(|o| (*o, 1)).collect();
            allocate(expense.amount_cents, &targets)
                .ok_or(NO_TARGETS)?
                .into_iter()
                .map(|s| (s.id, s.cents))
                .collect()
        };
        for (order, cents) in shares {
            by_order
                .entry((expense.currency.clone(), order))
                .or_default()
                .push(ExpenseShare { cents, expense });
        }
    }
    Ok(by_order)
}

/// An order's part of the cost of the receipts it drew from.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OrderCost {
    cents: i64,
    provenance: Provenance,
    quantity: i64,
    /// Blank when the receipts' costs are in different currencies.
    currency: String,
}

/// What the receipts say about each order (by id): its cost, and how many of its units were
/// settled from stock. Nothing is known when the allocations were not all read.
#[derive(Default)]
struct ReceiptCosts {
    by_order: HashMap<i64, OrderCost>,
    settled_by_order: HashMap<i64, i64>,
}

fn allocate_receipt_costs(evidence: &Evidence) -> Result<ReceiptCosts, String> {
    let mut costs = ReceiptCosts::default();
    if !evidence.allocations_complete {
        return Ok(costs);
    }
    let mut receipts: Vec<i32> = Vec::new();
    let mut by_receipt: HashMap<i32, Vec<&evidence::AllocationRow>> = HashMap::new();
    for row in &evidence.allocations {
        by_receipt
            .entry(row.receipt_id)
            .or_insert_with(|| {
                receipts.push(row.receipt_id);
                Vec::new()
            })
            .push(row);
    }
    for receipt in receipts {
        let rows = &by_receipt[&receipt];
        let sample = rows[0];
        let mut sold: Vec<(String, i64)> = Vec::new();
        for row in rows {
            let drawn = row.disposition_id.is_none()
                && row.quantity_correction_id.is_none()
                && row.replay_status.is_none()
                && matches!(row.fifo_state.as_str(), "allocated" | "partial");
            if !drawn {
                continue;
            }
            let id = row.order_id.to_string();
            match sold.iter_mut().find(|(order, _)| *order == id) {
                Some((_, quantity)) => *quantity += row.quantity,
                None => sold.push((id, row.quantity)),
            }
            *costs.settled_by_order.entry(row.order_id).or_insert(0) += row.quantity;
        }
        let (Some(total), Some(provenance), Some(currency)) = (
            sample.allocated_cost_cents,
            sample.cost_provenance.as_deref(),
            sample.cost_currency.as_deref(),
        ) else {
            continue;
        };
        let sold_quantity: i64 = sold.iter().map(|(_, q)| q).sum();
        let mut targets: Vec<(&str, u64)> = sold
            .iter()
            .map(|(id, q)| (id.as_str(), u64::try_from(*q).unwrap_or(0)))
            .collect();
        if sample.original_quantity > sold_quantity {
            targets.push((
                REMAINING_INVENTORY,
                u64::try_from(sample.original_quantity - sold_quantity).unwrap_or(0),
            ));
        }
        for share in allocate(total, &targets).ok_or(NO_TARGETS)? {
            if share.id == REMAINING_INVENTORY {
                continue;
            }
            let Ok(order) = share.id.parse::<i64>() else {
                continue;
            };
            let quantity = sold
                .iter()
                .find(|(id, _)| *id == share.id)
                .map_or(0, |(_, q)| *q);
            let estimated = evidence::provenance(provenance) == Provenance::Estimated;
            let next = match costs.by_order.get(&order) {
                Some(prior) => OrderCost {
                    cents: prior.cents + share.cents,
                    provenance: if prior.provenance == Provenance::Estimated || estimated {
                        Provenance::Estimated
                    } else {
                        Provenance::Actual
                    },
                    quantity: prior.quantity + quantity,
                    currency: if prior.currency == currency {
                        currency.to_owned()
                    } else {
                        String::new()
                    },
                },
                None => OrderCost {
                    cents: share.cents,
                    provenance: evidence::provenance(provenance),
                    quantity,
                    currency: currency.to_owned(),
                },
            };
            costs.by_order.insert(order, next);
        }
    }
    Ok(costs)
}

fn postage_evidence(evidence: &Evidence) -> Vec<PostageEvidence> {
    evidence
        .postage
        .iter()
        .map(|row| PostageEvidence {
            provider_identity: row.provider_identity.clone(),
            order_numbers: row.order_numbers.clone(),
            currency: row.currency.clone(),
            rate_cents: row.rate_cents,
            linked_sellers: row.linked_sellers.clone(),
            linked_order_count: row.linked_order_count,
        })
        .collect()
}

/// The economics of every order in `evidence`, in its order.
pub fn calculate_orders(seller: &str, evidence: &Evidence) -> Result<Vec<OrderEconomics>, String> {
    let expenses_by_order = allocate_shared_expenses(&evidence.expenses)?;
    let costs = allocate_receipt_costs(evidence)?;
    let postage_by_order = if evidence.postage_complete {
        allocate_purchased_postage(seller, "USD", &postage_evidence(evidence))
    } else {
        Default::default()
    };
    let assumed_postage = assume_postage_cents(postage_by_order.values().copied());
    Ok(evidence
        .orders
        .iter()
        .map(|o| {
            economics(
                o,
                evidence,
                &expenses_by_order,
                &costs,
                &postage_by_order,
                assumed_postage,
            )
        })
        .collect())
}

fn economics(
    o: &OrderRow,
    evidence: &Evidence,
    expenses_by_order: &HashMap<(String, String), Vec<ExpenseShare<'_>>>,
    costs: &ReceiptCosts,
    postage_by_order: &std::collections::BTreeMap<String, i64>,
    assumed_postage: i64,
) -> OrderEconomics {
    let none = Vec::new();
    let expenses = expenses_by_order
        .get(&(o.currency.clone(), o.order_number.clone()))
        .unwrap_or(&none);
    let financial = fingerprint::financial(&o.transaction(), &o.refund_records());
    let recorded_settlement = expenses.iter().find(|s| {
        s.expense.expense_type == "refund_settlement"
            && s.expense.financial_source_fingerprint.as_deref() == Some(financial.as_str())
    });
    let other_expenses: Vec<(i64, Provenance)> = expenses
        .iter()
        .filter(|s| s.expense.expense_type != "refund_settlement")
        .map(|s| (s.cents, s.expense.provenance()))
        .collect();
    let raw_cost = costs.by_order.get(&o.id);
    let settled_quantity = costs.settled_by_order.get(&o.id).copied().unwrap_or(0);
    let cost = raw_cost.filter(|c| {
        c.quantity == o.ordered_quantity
            && settled_quantity == o.ordered_quantity
            && c.currency == o.currency
    });
    let explicit_fulfillment = expenses
        .iter()
        .any(|s| s.expense.expense_type == "fulfillment");
    let purchased_postage = postage_by_order.get(&o.order_number).copied();
    let postage_cents = purchased_postage.or(if explicit_fulfillment {
        None
    } else if o.canceled() {
        Some(0)
    } else {
        Some(assumed_postage)
    });
    let refund = refund_evidence(&o.refund_records());
    let settlement = match recorded_settlement {
        Some(s) => Some(Settlement {
            cents: s.cents,
            provenance: s.expense.provenance(),
            basis: if s.expense.basis == "already_adjusted_net" {
                SettlementBasis::AlreadyAdjustedNet
            } else {
                SettlementBasis::OriginalNetRefundAdjustment
            },
        }),
        None if matches!(refund, Refund::Known(_)) || o.canceled() => {
            let gross = if let Refund::Known(cents) = refund {
                cents
            } else {
                0
            };
            let (cents, basis) = assume_refund_settlement(
                o.canceled(),
                gross,
                o.gross_order_cents,
                o.provider_net_cents,
            );
            Some(Settlement {
                cents,
                provenance: Provenance::Estimated,
                basis,
            })
        }
        None => None,
    };
    let postage_coverage = if purchased_postage.is_some() {
        Coverage::Actual
    } else if explicit_fulfillment {
        if expenses
            .iter()
            .any(|s| s.expense.provenance() == Provenance::Estimated)
        {
            Coverage::Estimated
        } else {
            Coverage::Actual
        }
    } else {
        Coverage::Estimated
    };
    order::calculate(&order::Evidence {
        order_number: o.order_number.clone(),
        currency: o.currency.clone(),
        canceled: o.canceled(),
        ordered_quantity: o.ordered_quantity,
        settled_quantity,
        cost_known_quantity: raw_cost.map_or(0, |c| c.quantity),
        gross_item_cents: o.gross_item_cents,
        gross_shipping_cents: o.gross_shipping_cents,
        gross_order_cents: o.gross_order_cents,
        platform_fee_cents: o.platform_fee_cents,
        provider_net_cents: o.provider_net_cents,
        direct_fee_cents: o.direct_fee_cents,
        refund: match refund {
            Refund::None => RefundState::None,
            Refund::Known(_) => RefundState::Known,
            Refund::Unknown => RefundState::Unknown,
        },
        settlement,
        postage_cents,
        postage_coverage,
        expense_evidence_complete: evidence.expenses_complete,
        other_expenses,
        acquisition_cost_cents: cost.map(|c| c.cents),
        acquisition_cost_coverage: cost.map_or(Coverage::Unknown, |c| match c.provenance {
            Provenance::Actual => Coverage::Actual,
            Provenance::Estimated => Coverage::Estimated,
        }),
    })
}
