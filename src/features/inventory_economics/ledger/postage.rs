//! Postage the seller bought, spread over the orders each label went with.
use std::collections::{BTreeMap, HashSet};

use super::money::allocate;

/// A label bought from the postage provider, and the orders and sellers it is linked to.
#[derive(Clone, Debug)]
pub struct PostageEvidence {
    pub provider_identity: String,
    pub order_numbers: Vec<String>,
    pub currency: Option<String>,
    pub rate_cents: Option<i64>,
    pub linked_sellers: Vec<String>,
    pub linked_order_count: i64,
}

/// Each order's share of the seller's labels in `currency`. A label counts once however many
/// times it was recorded, and only when every order it is linked to is here and it belongs to
/// this seller alone.
pub fn allocate_purchased_postage(
    seller: &str,
    currency: &str,
    records: &[PostageEvidence],
) -> BTreeMap<String, i64> {
    let mut seen = HashSet::new();
    let mut by_order = BTreeMap::new();
    for record in records {
        if !seen.insert(record.provider_identity.as_str()) {
            continue;
        }
        let mut orders: Vec<&str> = record
            .order_numbers
            .iter()
            .map(|o| o.trim())
            .filter(|o| !o.is_empty())
            .collect();
        orders.sort_unstable();
        orders.dedup();
        let Some(rate) = record.rate_cents.filter(|r| *r >= 0) else {
            continue;
        };
        if orders.is_empty()
            || record.linked_order_count != orders.len() as i64
            || record.linked_sellers != [seller]
            || record.currency.as_deref() != Some(currency)
        {
            continue;
        }
        let targets: Vec<(&str, u64)> = orders.iter().map(|o| (*o, 1)).collect();
        for share in allocate(rate, &targets).unwrap_or_default() {
            *by_order.entry(share.id).or_insert(0) += share.cents;
        }
    }
    by_order
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(
        id: &str,
        orders: &[&str],
        currency: &str,
        rate: i64,
        sellers: &[&str],
    ) -> PostageEvidence {
        PostageEvidence {
            provider_identity: id.into(),
            order_numbers: orders.iter().map(|o| (*o).into()).collect(),
            currency: Some(currency.into()),
            rate_cents: Some(rate),
            linked_sellers: sellers.iter().map(|s| (*s).into()).collect(),
            linked_order_count: orders.len() as i64,
        }
    }

    #[test]
    fn a_label_counts_once_across_its_whole_order_group() {
        let allocated = allocate_purchased_postage(
            "seller-a",
            "USD",
            &[
                label("shp-out", &["B", "A"], "USD", 501, &["seller-a"]),
                label("shp-out", &["B", "A"], "USD", 501, &["seller-a"]),
                label("shp-return", &["A"], "USD", 99, &["seller-a"]),
                label(
                    "cross-seller",
                    &["A", "C"],
                    "USD",
                    800,
                    &["seller-a", "seller-b"],
                ),
                label("wrong-currency", &["A"], "CAD", 100, &["seller-a"]),
            ],
        );
        assert_eq!(allocated.get("A"), Some(&350));
        assert_eq!(allocated.get("B"), Some(&250));
        assert_eq!(allocated.values().sum::<i64>(), 600);
    }
}
