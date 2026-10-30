//! A TCGplayer sale as the per-card value pricing reads. Ported from `getEffectiveSalePrice.ts`.

/// Below this unit price, shipping is a basket charge rather than card value.
pub const FREE_SHIPPING_THRESHOLD: f64 = 5.0;

/// The unit purchase price, plus the order's shipping split over its cards when the card is
/// worth at least the free-shipping threshold.
pub fn effective_sale_price(
    purchase_price: Option<f64>,
    shipping_price: Option<f64>,
    quantity: Option<f64>,
) -> f64 {
    let unit = purchase_price.unwrap_or(0.0);
    let shipping = shipping_price.unwrap_or(0.0);
    let quantity = quantity.filter(|q| *q > 0.0).unwrap_or(1.0);
    let shipping_per_unit = if unit >= FREE_SHIPPING_THRESHOLD {
        shipping / quantity
    } else {
        0.0
    };
    unit + shipping_per_unit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipping_counts_only_at_or_above_the_threshold() {
        assert_eq!(effective_sale_price(Some(4.99), Some(1.0), Some(1.0)), 4.99);
        assert_eq!(effective_sale_price(Some(5.0), Some(2.0), Some(2.0)), 6.0);
        assert_eq!(effective_sale_price(Some(10.0), Some(3.0), Some(0.0)), 13.0);
        assert_eq!(effective_sale_price(None, None, None), 0.0);
    }
}
