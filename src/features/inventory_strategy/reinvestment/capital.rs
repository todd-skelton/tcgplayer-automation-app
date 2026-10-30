//! The capital a purchase tied up: a lot that cost less than nothing offsets the others, so the
//! netted total is spread over the positive-cost lots by their cost and the negative lots carry
//! none. A purchase whose lots are all nonnegative is unchanged.
use std::collections::BTreeMap;

use crate::features::inventory_economics::ledger::money::allocate;

#[derive(Debug, PartialEq, Eq)]
pub struct PurchaseCapital {
    /// Cash the purchase actually tied up: the netted total, never below zero.
    pub total_amount_cents: i64,
    /// Capital carried by each lot (by receipt), in the order the lots were given.
    pub lot_amount_cents: Vec<(i64, i64)>,
}

impl PurchaseCapital {
    pub fn of(&self, receipt: i64) -> i64 {
        self.lot_amount_cents
            .iter()
            .find(|(id, _)| *id == receipt)
            .map_or(0, |(_, cents)| *cents)
    }
}

/// `lots` as (receipt, signed cost in cents).
pub fn purchase_capital(lots: &[(i64, i64)]) -> PurchaseCapital {
    let total_amount_cents = lots.iter().map(|(_, c)| c).sum::<i64>().max(0);
    let mut by_receipt: BTreeMap<i64, i64> = lots.iter().map(|(id, _)| (*id, 0)).collect();
    if total_amount_cents > 0 {
        let ids: Vec<String> = lots
            .iter()
            .filter(|(_, c)| *c > 0)
            .map(|(id, _)| id.to_string())
            .collect();
        let targets: Vec<(&str, u64)> = lots
            .iter()
            .filter(|(_, c)| *c > 0)
            .zip(&ids)
            .map(|((_, c), id)| (id.as_str(), *c as u64))
            .collect();
        for share in allocate(total_amount_cents, &targets).unwrap_or_default() {
            if let Ok(id) = share.id.parse() {
                by_receipt.insert(id, share.cents);
            }
        }
    }
    let mut seen = Vec::new();
    let lot_amount_cents = lots
        .iter()
        .filter(|(id, _)| {
            let first = !seen.contains(id);
            seen.push(*id);
            first
        })
        .map(|(id, _)| (*id, by_receipt[id]))
        .collect();
    PurchaseCapital {
        total_amount_cents,
        lot_amount_cents,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_lot_costs_net_into_the_positive_lots() {
        let same = purchase_capital(&[(1, 700), (2, 0), (3, 5)]);
        assert_eq!(same.total_amount_cents, 705);
        assert_eq!(same.lot_amount_cents, [(1, 700), (2, 0), (3, 5)]);
        let netted = purchase_capital(&[(1, 600), (2, 300), (3, -90)]);
        assert_eq!(netted.total_amount_cents, 810);
        assert_eq!(netted.lot_amount_cents, [(1, 540), (2, 270), (3, 0)]);
        let paid = purchase_capital(&[(1, -20), (2, -30)]);
        assert_eq!(paid.total_amount_cents, 0);
        assert_eq!(paid.lot_amount_cents, [(1, 0), (2, 0)]);
    }
}
