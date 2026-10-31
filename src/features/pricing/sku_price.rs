//! The price of one SKU from its product's latest sales: the sales put in the SKU's condition's
//! terms, the competing asks in the same terms, the time-decayed curve and the evidence a pricer
//! guards it with. Ported from `getSuggestedPriceFromLatestSales`; where the evidence comes from
//! (TCGplayer, the ledgers or a recording) is the [`Evidence`] given.

use super::buyer_arrival_rate::LATEST_SALES_HISTORY_DAYS;
use super::condition_normalization::{self, Diagnostics, Multipliers, Options as Normalization};
use super::condition_sale_rate::{self, SaleRate, SalesBucket};
use super::latest_sales_price::{self, Point, SuggestOptions};
use super::marketplace_price::PriceEvidence;
use super::sale::Sale;
use super::supply_analysis::{self, Observation as Supply};

const MILLISECONDS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const SEALED: &str = "Unopened";

/// The SKU being priced.
#[derive(Clone, Debug, PartialEq)]
pub struct Sku {
    pub sku: i64,
    pub product_id: i64,
    pub product_line_id: i64,
    pub condition: String,
    pub variant: String,
    pub language: String,
}

/// One week of a SKU's annual price history.
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryBucket {
    pub market_price: f64,
    pub transaction_count: f64,
    /// `YYYY-MM-DD`.
    pub bucket_start_date: String,
}

/// One SKU's annual price history, as the price history API reports it.
#[derive(Clone, Debug, PartialEq)]
pub struct History {
    pub sku_id: i64,
    pub condition: String,
    pub variant: String,
    pub language: String,
    pub buckets: Vec<HistoryBucket>,
}

/// Where a pricer reads its evidence.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait Evidence {
    /// The product's latest sales in the SKU's variant and language, every condition.
    async fn latest_sales(&self, sku: &Sku) -> Result<Vec<Sale>, String>;
    /// The product's annual price history, every SKU; none when unavailable.
    async fn price_history(&self, product_id: i64) -> Option<Vec<History>>;
    /// Every seller's cheapest ask per condition delivered at or under the ceiling, without the
    /// excluded seller's; unavailable when the listings cannot be read.
    async fn listings(
        &self,
        sku: &Sku,
        ceiling: Option<f64>,
        excluded_seller_key: Option<&str>,
    ) -> Supply;
    /// The cheapest delivered ask in the SKU's own condition, from someone other than the
    /// excluded seller.
    async fn lowest_listing_price(
        &self,
        sku: &Sku,
        excluded_seller_key: Option<&str>,
    ) -> Option<f64>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub half_life_days: Option<f64>,
    pub percentile: f64,
    pub additional_percentiles: Vec<f64>,
    pub available_since: Option<f64>,
    pub supply_analysis: bool,
    /// The store's own seller key, kept out of the competing asks.
    pub excluded_seller_key: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            half_life_days: Some(latest_sales_price::DEFAULT_HALF_LIFE_DAYS),
            percentile: latest_sales_price::DEFAULT_PERCENTILE,
            additional_percentiles: Vec::new(),
            available_since: None,
            supply_analysis: false,
            excluded_seller_key: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Priced {
    pub suggested_price: Option<f64>,
    pub lowest_listing_price: Option<f64>,
    pub total_quantity: f64,
    pub sale_count: usize,
    pub historical_sales_velocity_ms: Option<f64>,
    pub estimated_time_to_sell_ms: Option<f64>,
    pub sales_count: Option<usize>,
    pub listings_count: Option<usize>,
    pub percentiles: Vec<Point>,
    pub used_cross_condition_analysis: bool,
    pub condition_multipliers: Option<Multipliers>,
    pub condition_normalization: Option<Diagnostics>,
    pub condition_sale_rate: Option<SaleRate>,
    pub price_evidence: Option<PriceEvidence>,
}

/// The latest market price of each condition of the SKU's product, variant and language.
fn sibling_market_prices(history: Option<&[History]>, sku: &Sku) -> [Option<f64>; 5] {
    let mut prices = [None; 5];
    for entry in history.unwrap_or_default() {
        if entry.variant != sku.variant || entry.language != sku.language {
            continue;
        }
        let mut latest: Option<(&HistoryBucket, f64)> = None;
        for bucket in &entry.buckets {
            let start = start_ms(&bucket.bucket_start_date);
            let newer = latest.is_none_or(|(_, best)| start > best);
            if bucket.market_price > 0.0 && newer {
                latest = Some((bucket, start));
            }
        }
        if let (Some((bucket, _)), Some(rank)) =
            (latest, condition_normalization::rank(&entry.condition))
        {
            prices[rank] = Some(bucket.market_price);
        }
    }
    prices
}

/// `new Date(text).getTime()` for the dates the history API writes; NaN otherwise, which no
/// comparison prefers, as in JavaScript.
fn start_ms(date: &str) -> f64 {
    chrono::NaiveDate::parse_from_str(date.get(..10).unwrap_or(date), "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map_or(f64::NAN, |t| t.and_utc().timestamp_millis() as f64)
}

/// `getSuggestedPriceFromLatestSales` as of `now`, in epoch milliseconds.
pub async fn price(
    sku: &Sku,
    config: &Config,
    evidence: &impl Evidence,
    now: f64,
) -> Result<Priced, String> {
    let excluded = config
        .excluded_seller_key
        .as_deref()
        .filter(|key| !key.is_empty());
    let all_sales = evidence.latest_sales(sku).await?;
    if all_sales.len() < 2 {
        return Ok(Priced {
            lowest_listing_price: evidence.lowest_listing_price(sku, excluded).await,
            ..Priced::default()
        });
    }

    let sealed = sku.condition == SEALED;
    let history = evidence.price_history(sku.product_id).await;
    let condition_sale_rate = history
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|entry| entry.sku_id == sku.sku)
        .and_then(|own| {
            let buckets: Vec<SalesBucket> = own
                .buckets
                .iter()
                .map(|b| SalesBucket {
                    bucket_start_date: b.bucket_start_date.clone(),
                    transaction_count: b.transaction_count,
                })
                .collect();
            condition_sale_rate::estimate(&buckets, now, config.available_since)
        });

    let options = Normalization {
        as_of: Some(now),
        sibling_market_prices: sibling_market_prices(history.as_deref(), sku),
    };
    let normalization = match (sealed, condition_normalization::rank(&sku.condition)) {
        (false, Some(target)) => Some(condition_normalization::fit(
            &all_sales, target, &options, now,
        )),
        // A condition outside the graded ones keeps every sale in its own terms.
        (false, None) => None,
        (true, _) => None,
    };
    let multipliers = normalization.as_ref().map(|(m, _)| *m);
    let to_process: Vec<Sale> = if sealed {
        all_sales
            .iter()
            .filter(|s| s.condition == SEALED)
            .cloned()
            .collect()
    } else {
        all_sales.clone()
    };
    let adjusted = condition_normalization::normalize_sales(&to_process, multipliers.as_ref());

    let product_listings = if config.supply_analysis {
        let ceiling = if sealed {
            to_process
                .iter()
                .map(Sale::effective_price)
                .reduce(f64::max)
        } else {
            // Node passes no as-of here, so the ceiling anchors to the newest sale.
            condition_normalization::competing_ask_ceiling(
                &to_process,
                &Normalization {
                    as_of: None,
                    ..options.clone()
                },
            )
        };
        evidence.listings(sku, ceiling, excluded).await
    } else {
        Supply::disabled()
    };
    let own_condition: Vec<_> = product_listings
        .listings
        .iter()
        .filter(|l| l.condition == sku.condition)
        .cloned()
        .collect();
    // Sealed products compete only with sealed listings.
    let supply = Supply {
        status: product_listings.status,
        listings: if sealed {
            own_condition.clone()
        } else {
            supply_analysis::normalize_listings(&product_listings.listings, multipliers.as_ref())
        },
    };

    let window_start = now - LATEST_SALES_HISTORY_DAYS * MILLISECONDS_PER_DAY;
    let own_condition_low_sale_price = all_sales
        .iter()
        .filter(|s| s.condition == sku.condition && s.timestamp() >= window_start)
        .map(Sale::effective_price)
        .filter(|p| *p > 0.0)
        .reduce(f64::min);
    // Without the store's own listing excluded, the second ask may be the cheapest competitor.
    let second_cheapest_ask_price = excluded
        .and_then(|_| own_condition.get(1))
        .map(supply_analysis::Listing::delivered);
    let price_evidence = (own_condition_low_sale_price.is_some()
        || second_cheapest_ask_price.is_some())
    .then_some(PriceEvidence {
        own_condition_low_sale_price,
        second_cheapest_ask_price,
    });

    let suggestion = latest_sales_price::suggest(
        &adjusted,
        &SuggestOptions {
            percentile: config.percentile,
            additional_percentiles: &config.additional_percentiles,
            half_life_days: config.half_life_days,
            as_of: now,
            available_since: config.available_since,
            supply: &supply,
        },
    );
    Ok(Priced {
        suggested_price: suggestion.suggested_price,
        lowest_listing_price: None,
        total_quantity: suggestion.total_quantity,
        sale_count: suggestion.sale_count,
        historical_sales_velocity_ms: suggestion.historical_sales_velocity_ms,
        estimated_time_to_sell_ms: suggestion.estimated_time_to_sell_ms,
        sales_count: suggestion.sales_count,
        listings_count: suggestion.listings_count,
        percentiles: suggestion.percentiles,
        used_cross_condition_analysis: !sealed,
        condition_multipliers: if sealed {
            None
        } else {
            Some(multipliers.unwrap_or([1.0; 5]))
        },
        condition_normalization: normalization.map(|(_, d)| d),
        condition_sale_rate,
        price_evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::super::policy::SupplyStatus;
    use super::super::supply_analysis::Listing;
    use super::*;

    const NOW: f64 = 1_788_220_800_000.0; // 2026-09-01T00:00:00Z

    struct Recorded {
        sales: Vec<Sale>,
        history: Option<Vec<History>>,
        listings: Vec<Listing>,
        lowest: Option<f64>,
    }

    impl Evidence for Recorded {
        async fn latest_sales(&self, _: &Sku) -> Result<Vec<Sale>, String> {
            Ok(self.sales.clone())
        }
        async fn price_history(&self, _: i64) -> Option<Vec<History>> {
            self.history.clone()
        }
        async fn listings(&self, _: &Sku, ceiling: Option<f64>, excluded: Option<&str>) -> Supply {
            let under: Vec<Listing> = self
                .listings
                .iter()
                .filter(|l| ceiling.is_none_or(|c| l.delivered() <= c))
                .cloned()
                .collect();
            supply_analysis::cheapest_asks(under, excluded)
        }
        async fn lowest_listing_price(&self, _: &Sku, _: Option<&str>) -> Option<f64> {
            self.lowest
        }
    }

    fn sku(condition: &str) -> Sku {
        Sku {
            sku: 7,
            product_id: 70,
            product_line_id: 1,
            condition: condition.into(),
            variant: "Normal".into(),
            language: "English".into(),
        }
    }

    fn sale(condition: &str, price: f64, days_ago: f64) -> Sale {
        let at =
            chrono::DateTime::from_timestamp_millis((NOW - days_ago * MILLISECONDS_PER_DAY) as i64)
                .unwrap();
        Sale {
            condition: condition.into(),
            variant: "Normal".into(),
            language: "English".into(),
            quantity: 1.0,
            purchase_price: price,
            order_date: at.to_rfc3339(),
            ..Sale::default()
        }
    }

    fn listing(condition: &str, price: f64, seller: &str) -> Listing {
        Listing {
            condition: condition.into(),
            price,
            shipping_cost: 0.0,
            seller_id: seller.into(),
            seller_key: seller.into(),
            listing_id: 1,
        }
    }

    #[tokio::test]
    async fn fewer_than_two_sales_offer_only_the_lowest_listing() {
        let evidence = Recorded {
            sales: vec![sale("Near Mint", 5.0, 1.0)],
            history: None,
            listings: Vec::new(),
            lowest: Some(4.5),
        };
        let priced = price(&sku("Near Mint"), &Config::default(), &evidence, NOW)
            .await
            .unwrap();
        assert_eq!(priced.suggested_price, None);
        assert_eq!(priced.lowest_listing_price, Some(4.5));
        assert!(priced.percentiles.is_empty());
        assert!(!priced.used_cross_condition_analysis);
    }

    #[tokio::test]
    async fn sealed_products_price_and_compete_with_sealed_copies_only() {
        let evidence = Recorded {
            sales: vec![
                sale("Unopened", 10.0, 1.0),
                sale("Unopened", 12.0, 2.0),
                sale("Near Mint", 100.0, 1.0),
            ],
            history: None,
            listings: vec![
                listing("Unopened", 9.0, "a"),
                listing("Near Mint", 1.0, "b"),
            ],
            lowest: None,
        };
        let config = Config {
            supply_analysis: true,
            ..Config::default()
        };
        let priced = price(&sku("Unopened"), &config, &evidence, NOW)
            .await
            .unwrap();
        assert_eq!(priced.sale_count, 2);
        assert!(!priced.used_cross_condition_analysis);
        assert_eq!(priced.condition_multipliers, None);
        let top = priced.percentiles.last().unwrap();
        assert!(top.price <= 12.0);
        assert_eq!(top.supply_status, SupplyStatus::Observed);
        // Near Mint is not sealed, and the ceiling (the top sealed sale, 12) is above the only
        // sealed ask, so that ask is the whole competition.
        assert_eq!(top.listings_count, Some(1));
    }

    #[tokio::test]
    async fn guards_read_the_own_condition_low_sale_and_the_second_ask_without_the_store() {
        let evidence = Recorded {
            sales: vec![
                sale("Near Mint", 10.0, 1.0),
                sale("Near Mint", 8.0, 100.0),
                sale("Near Mint", 9.0, 3.0),
                sale("Lightly Played", 7.0, 2.0),
            ],
            history: None,
            listings: vec![
                listing("Near Mint", 8.5, "store"),
                listing("Near Mint", 9.5, "a"),
                listing("Near Mint", 9.75, "b"),
            ],
            lowest: None,
        };
        let config = Config {
            supply_analysis: true,
            excluded_seller_key: Some("store".into()),
            ..Config::default()
        };
        let priced = price(&sku("Near Mint"), &config, &evidence, NOW)
            .await
            .unwrap();
        assert_eq!(
            priced.price_evidence,
            Some(PriceEvidence {
                // The 100-day-old sale is outside the 90-day window.
                own_condition_low_sale_price: Some(9.0),
                second_cheapest_ask_price: Some(9.75),
            })
        );
        assert!(priced.used_cross_condition_analysis);
        assert!(priced.condition_normalization.is_some());
    }

    #[test]
    fn siblings_take_each_conditions_newest_market_price_in_the_skus_variant_and_language() {
        let entry = |condition: &str, variant: &str, buckets: &[(&str, f64)]| History {
            sku_id: 1,
            condition: condition.into(),
            variant: variant.into(),
            language: "English".into(),
            buckets: buckets
                .iter()
                .map(|(date, price)| HistoryBucket {
                    market_price: *price,
                    transaction_count: 1.0,
                    bucket_start_date: (*date).into(),
                })
                .collect(),
        };
        let history = [
            entry(
                "Near Mint",
                "Normal",
                &[
                    ("2026-08-01", 0.0),
                    ("2026-07-25", 20.0),
                    ("2026-07-18", 30.0),
                ],
            ),
            entry("Lightly Played", "Foil", &[("2026-08-01", 99.0)]),
            entry("Damaged", "Normal", &[("2026-08-01", 5.0)]),
        ];
        let prices = sibling_market_prices(Some(&history), &sku("Near Mint"));
        assert_eq!(prices, [Some(20.0), None, None, None, Some(5.0)]);
    }
}
