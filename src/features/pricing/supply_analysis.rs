//! How competing listings slow a sale: each seller's cheapest ask per condition, how many sellers
//! undercut a price, and the sell time once buyers split between them. Ported from
//! `app/features/pricing/services/supplyAnalysisService.ts` with its tests; fetching the listings
//! is the TCGplayer client's job.

use std::collections::{HashMap, HashSet};

use super::condition_normalization::{self, Multipliers};
use super::policy::SupplyStatus;

/// One seller's ask for a copy of the card, delivered price split into price and shipping.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listing {
    pub condition: String,
    pub price: f64,
    pub shipping_cost: f64,
    pub seller_id: String,
    pub seller_key: String,
    pub listing_id: i64,
}

impl Listing {
    pub fn delivered(&self) -> f64 {
        self.price + self.shipping_cost
    }

    /// The seller the ask belongs to: its key, else its id, else the listing itself.
    fn seller(&self) -> String {
        if !self.seller_key.is_empty() {
            self.seller_key.clone()
        } else if !self.seller_id.is_empty() {
            self.seller_id.clone()
        } else {
            format!("listing:{}", self.listing_id)
        }
    }
}

/// The listings competing with a SKU, and whether they were looked at at all.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub status: SupplyStatus,
    pub listings: Vec<Listing>,
}

impl Observation {
    pub fn disabled() -> Self {
        Observation {
            status: SupplyStatus::Disabled,
            listings: Vec::new(),
        }
    }

    pub fn unavailable() -> Self {
        Observation {
            status: SupplyStatus::Unavailable,
            listings: Vec::new(),
        }
    }
}

/// Each seller's cheapest ask in each graded condition, cheapest delivered first, without the
/// store's own asks. Buyers weigh condition against price, so a listing competes with asks in
/// every condition once they are in its own condition's terms.
pub fn cheapest_asks(listings: Vec<Listing>, excluded_seller_key: Option<&str>) -> Observation {
    let mut cheapest: HashMap<String, Listing> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for listing in listings {
        if excluded_seller_key.is_some_and(|key| !key.is_empty() && listing.seller_key == key) {
            continue;
        }
        if condition_normalization::rank(&listing.condition).is_none() {
            continue;
        }
        let key = format!("{} {}", listing.seller(), listing.condition);
        match cheapest.get(&key) {
            Some(current) if listing.delivered() >= current.delivered() => {}
            Some(_) => {
                cheapest.insert(key, listing);
            }
            None => {
                order.push(key.clone());
                cheapest.insert(key, listing);
            }
        }
    }
    // A Map keeps first-insertion order and Array.sort is stable, so ties stay in that order.
    let mut listings: Vec<Listing> = order
        .into_iter()
        .filter_map(|key| cheapest.remove(&key))
        .collect();
    listings.sort_by(|a, b| a.delivered().total_cmp(&b.delivered()));
    Observation {
        status: SupplyStatus::Observed,
        listings,
    }
}

/// Every ask in the target condition's terms: price and shipping scaled by its condition's
/// multiplier (1 without multipliers or for an ungraded condition).
pub fn normalize_listings(listings: &[Listing], multipliers: Option<&Multipliers>) -> Vec<Listing> {
    listings
        .iter()
        .map(|listing| {
            let m = condition_normalization::multiplier(multipliers, &listing.condition);
            Listing {
                price: listing.price * m,
                shipping_cost: listing.shipping_cost * m,
                ..listing.clone()
            }
        })
        .collect()
}

/// Sellers with an ask delivered at or below the price, each counted once.
pub fn count_competing_sellers(listings: &[Listing], target_price: f64) -> usize {
    listings
        .iter()
        .filter(|listing| listing.delivered() <= target_price)
        .map(Listing::seller)
        .collect::<HashSet<_>>()
        .len()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SupplyAdjusted {
    /// Median time to sell in milliseconds, when buyers arrive at all.
    pub time_ms: Option<f64>,
    pub listings_count: usize,
    pub store_win_share: f64,
}

/// The median wait for a buyer once arriving buyers split evenly between the store and every
/// seller asking no more than the price.
pub fn supply_adjusted_time_to_sell(
    listings: &[Listing],
    target_price: f64,
    buyer_interval_ms: Option<f64>,
) -> SupplyAdjusted {
    let interval = buyer_interval_ms.filter(|ms| *ms != 0.0 && !ms.is_nan());
    if listings.is_empty() {
        return SupplyAdjusted {
            time_ms: interval.map(|ms| ms * std::f64::consts::LN_2),
            listings_count: 0,
            store_win_share: 1.0,
        };
    }
    let listings_count = count_competing_sellers(listings, target_price);
    let store_win_share = 1.0 / (listings_count as f64 + 1.0);
    SupplyAdjusted {
        time_ms: interval
            .filter(|ms| *ms > 0.0)
            .map(|ms| std::f64::consts::LN_2 * ms / store_win_share),
        listings_count,
        store_win_share,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

    fn listing(condition: &str, price: f64, shipping: f64, seller: &str, id: i64) -> Listing {
        Listing {
            condition: condition.into(),
            price,
            shipping_cost: shipping,
            seller_id: seller.into(),
            seller_key: format!("seller-{seller}"),
            listing_id: id,
        }
    }

    #[test]
    fn supply_adjustment_counts_observed_seller_choices_once() {
        let listings = [
            listing("Near Mint", 9.0, 1.0, "1", 1),
            listing("Near Mint", 9.5, 1.0, "1", 2),
            listing("Near Mint", 10.0, 0.0, "2", 3),
        ];
        assert_eq!(count_competing_sellers(&listings, 10.0), 2);
        let adjusted = supply_adjusted_time_to_sell(&listings, 10.0, Some(5.0 * DAY_MS));
        let expected = 15.0 * std::f64::consts::LN_2 * DAY_MS;
        assert!((adjusted.time_ms.unwrap() - expected).abs() < 0.01);
        assert_eq!(adjusted.listings_count, 2);
        assert_eq!(adjusted.store_win_share, 1.0 / 3.0);
    }

    #[test]
    fn competing_sellers_pool_every_condition_of_the_card() {
        let product = [
            listing("Near Mint", 10.61, 0.0, "nm", 10),
            listing("Moderately Played", 9.5, 0.0, "mp", 11),
            listing("Lightly Played", 10.99, 0.0, "lp", 12),
        ];
        let onto_lightly_played: Multipliers = [0.9, 1.0, 1.1, 1.0, 1.0];
        let normalized = normalize_listings(&product, Some(&onto_lightly_played));
        let prices: Vec<(&str, f64)> = normalized
            .iter()
            .map(|l| (l.condition.as_str(), (l.price * 1000.0).round() / 1000.0))
            .collect();
        assert_eq!(
            prices,
            [
                ("Near Mint", 9.549),
                ("Moderately Played", 10.45),
                ("Lightly Played", 10.99)
            ]
        );
        assert_eq!(count_competing_sellers(&normalized, 10.0), 1);
        assert_eq!(count_competing_sellers(&normalized, 10.61), 2);
        assert_eq!(count_competing_sellers(&normalized, 10.99), 3);
        assert_eq!(
            count_competing_sellers(&normalize_listings(&product, None), 10.0),
            1
        );
    }

    #[test]
    fn no_competition_waits_the_median_buyer_and_no_buyers_forecast_nothing() {
        let alone = supply_adjusted_time_to_sell(&[], 10.0, Some(DAY_MS));
        assert_eq!(alone.time_ms, Some(DAY_MS * std::f64::consts::LN_2));
        assert_eq!(alone.store_win_share, 1.0);
        let crowded =
            supply_adjusted_time_to_sell(&[listing("Near Mint", 1.0, 0.0, "a", 1)], 10.0, None);
        assert_eq!(crowded.time_ms, None);
        assert_eq!(crowded.listings_count, 1);
    }

    #[test]
    fn each_seller_keeps_its_cheapest_ask_per_condition_without_the_store() {
        let observed = cheapest_asks(
            vec![
                listing("Near Mint", 5.0, 1.0, "a", 1),
                listing("Near Mint", 4.0, 1.0, "a", 2),
                listing("Lightly Played", 3.0, 0.0, "a", 3),
                listing("Near Mint", 2.0, 0.0, "store", 4),
                listing("Unopened", 1.0, 0.0, "b", 5),
            ],
            Some("seller-store"),
        );
        assert_eq!(observed.status, SupplyStatus::Observed);
        let ids: Vec<i64> = observed.listings.iter().map(|l| l.listing_id).collect();
        assert_eq!(ids, [3, 2]);
    }
}
