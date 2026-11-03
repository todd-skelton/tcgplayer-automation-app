//! Evidence read live from TCGplayer: a product's latest sales (`getAllLatestSales`), its annual
//! price history (a GET), and the competing listings (`getAllListings`, read as
//! `SupplyAnalysisService` reads them: standard listings in the SKU's variant and language, cheapest
//! delivered first, from verified sellers unless the configuration includes unverified ones). All
//! are reads, though the sales and listings searches are POSTs. What is read is kept in the sales,
//! weekly sales and listing ledgers beside the price ([`ledger`](super::ledger)).
use std::{future::Future, time::Duration};

use serde::{Deserialize, Serialize};

use super::buyer_arrival_rate::LATEST_SALES_LIMIT;
use super::ledger::{self, HistorySku};
use super::policy::SupplyStatus;
use super::sale::Sale;
use super::sku_price::{Competitors, Evidence, Failure, History, HistoryBucket, Sku};
use super::supply_analysis::{self, Listing, Observation as Supply};
use crate::{
    database::Database,
    features::http_configuration::config::Domain,
    tcgplayer::{self, Call, TcgPlayer},
};

/// A signed-out session sees only a product's five latest sales and is told five is the total.
pub const ANONYMOUS_SALES_LIMIT: usize = 5;
/// The page size TCGplayer's latest sales are asked for in.
const PAGE_SIZE: usize = 25;
const BUSIEST_PRODUCT_LOOKBACK_DAYS: i64 = 7;
/// The page size the competing listings are asked for in.
const LISTINGS_PAGE_SIZE: usize = 50;

/// The body of a listings search (`GetListingsRequestBody`): standard listings of one product,
/// cheapest delivered first.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListingsQuery {
    pub filters: ListingFilters,
    pub from: usize,
    pub size: usize,
    pub sort: ListingSort,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListingFilters {
    pub term: ListingTerm,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListingTerm {
    #[serde(rename = "listingType")]
    pub listing_type: [&'static str; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<[String; 1]>,
    pub language: [String; 1],
    pub printing: [String; 1],
    /// `true` for verified sellers only; absent to include every seller.
    #[serde(rename = "verified-seller", skip_serializing_if = "Option::is_none")]
    pub verified_seller: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ListingSort {
    pub field: &'static str,
    pub order: &'static str,
}

impl ListingsQuery {
    /// The SKU's product in its variant and language, every condition unless `condition` names one.
    pub fn new(sku: &Sku, condition: Option<&str>, unverified: bool, size: usize) -> Self {
        ListingsQuery {
            filters: ListingFilters {
                term: ListingTerm {
                    listing_type: ["standard"],
                    condition: condition.map(|c| [c.to_owned()]),
                    language: [sku.language.clone()],
                    printing: [sku.variant.clone()],
                    verified_seller: (!unverified).then_some(true),
                },
            },
            from: 0,
            size,
            sort: ListingSort {
                field: "price+shipping",
                order: "asc",
            },
        }
    }
}

/// One page of a listings search: TCGplayer answers a list with one result set.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ListingsAnswer {
    pub results: Vec<ListingsPage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListingsPage {
    pub total_results: usize,
    pub results: Vec<ListedAsk>,
}

/// A listing as the search reports it, the fields supply analysis reads.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListedAsk {
    pub listing_id: i64,
    pub condition: String,
    pub price: f64,
    pub seller_shipping_price: f64,
    pub seller_id: String,
    pub seller_key: String,
}

impl ListedAsk {
    fn delivered(&self) -> f64 {
        self.price + self.seller_shipping_price
    }

    fn into_listing(self) -> Listing {
        Listing {
            condition: self.condition,
            price: self.price,
            shipping_cost: self.seller_shipping_price,
            seller_id: self.seller_id,
            seller_key: self.seller_key,
            listing_id: self.listing_id,
        }
    }
}

/// Every listing the query finds, as `getAllListings` pages them: pages of the query's size until
/// the total is read, stopping after a page that reaches an ask delivered above `ceiling` (that
/// page is kept whole).
pub async fn all_listings<F, Fut>(
    query: ListingsQuery,
    ceiling: Option<f64>,
    mut page: F,
) -> Result<Vec<ListedAsk>, tcgplayer::Failure>
where
    F: FnMut(ListingsQuery) -> Fut,
    Fut: Future<Output = Result<ListingsAnswer, tcgplayer::Failure>>,
{
    let size = query.size;
    let mut from = 0;
    let mut total = 0;
    let mut listings = Vec::new();
    loop {
        let answer = page(ListingsQuery {
            from,
            ..query.clone()
        })
        .await?;
        let Some(first) = answer.results.into_iter().next() else {
            return Err(tcgplayer::Failure::Unreadable(
                "a listings answer with no result set".into(),
            ));
        };
        if from == 0 {
            total = first.total_results;
        }
        let past_ceiling = ceiling.is_some_and(|c| first.results.iter().any(|l| l.delivered() > c));
        listings.extend(first.results);
        from += size;
        if past_ceiling || listings.len() >= total || from >= total {
            return Ok(listings);
        }
    }
}

/// The cheapest delivered ask on a page from someone other than the excluded seller, when it is
/// a price (`fetchLowestListingPrice`).
pub fn lowest_ask(page: &[ListedAsk], excluded_seller_key: Option<&str>) -> Option<f64> {
    let ask = page
        .iter()
        .find(|l| excluded_seller_key.is_none_or(|key| l.seller_key != key))?;
    let delivered = ask.delivered();
    (delivered.is_finite() && delivered > 0.0).then_some(delivered)
}

/// The body of a latest-sales request (`GetLastestSalesRequestBody`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesQuery {
    pub conditions: Vec<i64>,
    pub languages: Vec<i64>,
    pub variants: Vec<i64>,
    pub listing_type: &'static str,
    pub offset: usize,
    pub limit: usize,
}

/// One page of latest sales.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SalesPage {
    pub next_page: String,
    pub total_results: usize,
    pub data: Vec<Sale>,
}

/// Every page of a product's latest sales up to `max`, as `getAllLatestSales` pages them: pages
/// of at most 25, the last one only as large as what is still wanted, until TCGplayer says there
/// is no next page.
pub async fn all_latest_sales<F, Fut>(
    query: SalesQuery,
    max: usize,
    mut page: F,
) -> Result<Vec<Sale>, tcgplayer::Failure>
where
    F: FnMut(SalesQuery) -> Fut,
    Fut: Future<Output = Result<SalesPage, tcgplayer::Failure>>,
{
    let mut offset = query.offset;
    let mut sales = Vec::new();
    while sales.len() < max {
        let limit = PAGE_SIZE.min(max - sales.len());
        let answer = page(SalesQuery {
            offset,
            limit,
            ..query.clone()
        })
        .await?;
        sales.extend(answer.data);
        if answer.next_page != "Yes" {
            break;
        }
        offset += limit;
    }
    Ok(sales)
}

/// Whether a fetch that asked for more than the signed-out limit came back with exactly that many
/// sales: the whole history of a product with five sales, or the signed-out view of any product.
pub fn could_be_anonymous(sale_count: usize, max: usize) -> bool {
    sale_count == ANONYMOUS_SALES_LIMIT && max > ANONYMOUS_SALES_LIMIT
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryAnswer {
    #[serde(default)]
    result: Vec<HistorySku>,
}

/// JavaScript's `Number(text)` for the history's numeric strings.
fn number(text: &str) -> f64 {
    let text = text.trim();
    if text.is_empty() {
        0.0
    } else {
        text.parse().unwrap_or(f64::NAN)
    }
}

impl From<&HistorySku> for History {
    fn from(entry: &HistorySku) -> Self {
        History {
            sku_id: number(&entry.sku_id) as i64,
            condition: entry.condition.clone(),
            variant: entry.variant.clone().unwrap_or_default(),
            language: entry.language.clone().unwrap_or_default(),
            buckets: entry
                .buckets
                .iter()
                .map(|b| HistoryBucket {
                    market_price: number(b.market_price.as_deref().unwrap_or("")),
                    transaction_count: number(&b.transaction_count),
                    bucket_start_date: b.bucket_start_date.clone(),
                })
                .collect(),
        }
    }
}

/// One attempt of a read, retried on a rate limit as Node's clients retry.
const READ: Call = Call {
    retry: true,
    timeout: Duration::from_secs(60),
};

/// Latest sales and price history from TCGplayer; the product line's language and variant ids
/// from the catalog's category filters.
#[derive(Clone)]
pub struct TcgPlayerEvidence {
    pub tcg: TcgPlayer,
    pub db: Database,
}

impl TcgPlayerEvidence {
    async fn filter_id(&self, sku: &Sku, column: &str, name: &str) -> Result<i64, Failure> {
        let entries: Option<serde_json::Value> = sqlx::query_scalar(&format!(
            "SELECT {column} FROM category_filters WHERE category_id = $1"
        ))
        .bind(sku.product_line_id as i32)
        .fetch_optional(&self.db.0)
        .await
        .map_err(|e| Failure::Sku(e.to_string()))?;
        entries
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .find(|entry| entry.get("name").and_then(serde_json::Value::as_str) == Some(name))
            .and_then(|entry| entry.get("id").and_then(serde_json::Value::as_i64))
            .ok_or_else(|| {
                Failure::Sku(format!(
                    "{name} is not available for product line {}",
                    sku.product_line_id
                ))
            })
    }

    async fn page(
        &self,
        product_id: i64,
        query: SalesQuery,
    ) -> Result<SalesPage, tcgplayer::Failure> {
        self.tcg
            .post(
                Domain::MpApi,
                &format!("/v2/product/{product_id}/latestsales"),
                &query,
                READ,
            )
            .await
    }

    /// Confirms the session still sees full sales history by asking about the product the sales
    /// ledger saw sell most this week; with an empty ledger the answer is trusted.
    async fn assert_full_history(&self) -> Result<(), Failure> {
        let busiest: Option<i32> = sqlx::query_scalar(
            "SELECT product_id FROM product_sales
             WHERE order_date >= now() - make_interval(days => $1)
             GROUP BY product_id ORDER BY COUNT(*) DESC, product_id LIMIT 1",
        )
        .bind(BUSIEST_PRODUCT_LOOKBACK_DAYS as i32)
        .fetch_optional(&self.db.0)
        .await
        .map_err(|e| Failure::Sku(e.to_string()))?;
        let Some(product_id) = busiest else {
            return Ok(());
        };
        let query = SalesQuery {
            conditions: Vec::new(),
            languages: Vec::new(),
            variants: Vec::new(),
            listing_type: "ListingWithoutPhotos",
            offset: 0,
            limit: ANONYMOUS_SALES_LIMIT + 1,
        };
        let total = self
            .page(product_id.into(), query)
            .await
            .map_err(|e| Failure::Sku(e.to_string()))?
            .total_results;
        if total > ANONYMOUS_SALES_LIMIT {
            return Ok(());
        }
        Err(Failure::SalesHistoryUnavailable(format!(
            "TCGplayer answered with the signed-out view of sales history: product {product_id} \
             sold more than {ANONYMOUS_SALES_LIMIT} times this week yet only {total} sales were \
             reported. Renew the TCGplayer auth cookie in HTTP configuration before pricing."
        )))
    }
}

impl Evidence for TcgPlayerEvidence {
    async fn latest_sales(&self, sku: &Sku) -> Result<Vec<Sale>, Failure> {
        let language = self.filter_id(sku, "languages", &sku.language).await?;
        let variant = self.filter_id(sku, "variants", &sku.variant).await?;
        let query = SalesQuery {
            conditions: Vec::new(),
            languages: vec![language],
            variants: vec![variant],
            listing_type: "ListingWithoutPhotos",
            offset: 0,
            limit: PAGE_SIZE,
        };
        let max = LATEST_SALES_LIMIT;
        let sales = all_latest_sales(query, max, |q| self.page(sku.product_id, q))
            .await
            .map_err(|e| Failure::Sku(e.to_string()))?;
        if could_be_anonymous(sales.len(), max) {
            self.assert_full_history().await?;
        }
        if !sales.is_empty() {
            let (product_id, recorded) = (sku.product_id, sales.clone());
            let what = format!("{} sales for product {product_id}", sales.len());
            ledger::in_background(&self.db, what, move |mut conn| async move {
                ledger::record_sales(&mut conn, product_id, &recorded).await
            });
        }
        Ok(sales)
    }

    async fn price_history(&self, product_id: i64) -> Option<Vec<History>> {
        let path = format!("/price/history/{product_id}/detailed?range=annual");
        let answer: HistoryAnswer = self
            .tcg
            .get(Domain::InfiniteApi, &path, READ)
            .await
            .inspect_err(|e| {
                eprintln!("Failed to fetch price history for product {product_id}: {e}")
            })
            .ok()?;
        let weeks = ledger::weekly_sales(product_id, &answer.result);
        let what = format!("weekly sales for product {product_id}");
        ledger::in_background(&self.db, what, move |mut conn| async move {
            ledger::record_weeks(&mut conn, &weeks).await
        });
        Some(answer.result.iter().map(History::from).collect())
    }

    async fn listings(&self, sku: &Sku, ceiling: Option<f64>, c: Competitors<'_>) -> Supply {
        let query = ListingsQuery::new(sku, None, c.include_unverified_sellers, LISTINGS_PAGE_SIZE);
        let path = format!("/v1/product/{}/listings", sku.product_id);
        match all_listings(query, ceiling, |q| {
            let path = path.clone();
            async move { self.tcg.post(Domain::MpSearchApi, &path, &q, READ).await }
        })
        .await
        {
            Ok(asks) => {
                let supply = supply_analysis::cheapest_asks(
                    asks.into_iter().map(ListedAsk::into_listing).collect(),
                    c.excluded_seller_key,
                );
                if supply.status == SupplyStatus::Observed {
                    let snapshots =
                        ledger::snapshots(sku, &supply.listings, chrono::Utc::now().date_naive());
                    let what = format!("listings for product {}", sku.product_id);
                    ledger::in_background(&self.db, what, move |mut conn| async move {
                        ledger::record_snapshots(&mut conn, &snapshots).await
                    });
                }
                supply
            }
            Err(e) => {
                eprintln!(
                    "Failed to fetch listings for product {} ({}, {}): {e}",
                    sku.product_id, sku.variant, sku.language
                );
                Supply {
                    status: SupplyStatus::Unavailable,
                    listings: Vec::new(),
                }
            }
        }
    }

    async fn lowest_listing_price(&self, sku: &Sku, c: Competitors<'_>) -> Option<f64> {
        let size = if c.excluded_seller_key.is_some() {
            50
        } else {
            1
        };
        let query = ListingsQuery::new(
            sku,
            Some(&sku.condition),
            c.include_unverified_sellers,
            size,
        );
        let path = format!("/v1/product/{}/listings", sku.product_id);
        let answer: ListingsAnswer = self
            .tcg
            .post(Domain::MpSearchApi, &path, &query, READ)
            .await
            .inspect_err(|e| eprintln!("Failed to fetch lowest listing for SKU {}: {e}", sku.sku))
            .ok()?;
        lowest_ask(
            answer.results.first().map_or(&[][..], |p| &p.results),
            c.excluded_seller_key,
        )
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    fn query() -> SalesQuery {
        SalesQuery {
            conditions: Vec::new(),
            languages: vec![1],
            variants: vec![11],
            listing_type: "ListingWithoutPhotos",
            offset: 0,
            limit: PAGE_SIZE,
        }
    }

    fn sales(count: usize) -> Vec<Sale> {
        vec![Sale::default(); count]
    }

    fn ask(id: i64, condition: &str, price: f64, shipping: f64, seller: &str) -> ListedAsk {
        ListedAsk {
            listing_id: id,
            condition: condition.into(),
            price,
            seller_shipping_price: shipping,
            seller_id: String::new(),
            seller_key: seller.into(),
        }
    }

    fn sku() -> Sku {
        Sku {
            sku: 4410660,
            product_id: 213155,
            product_line_id: 3,
            condition: "Near Mint".into(),
            variant: "Holofoil".into(),
            language: "English".into(),
        }
    }

    #[test]
    fn a_listings_search_asks_as_node_does() {
        let body = serde_json::to_value(ListingsQuery::new(&sku(), None, false, 50)).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "filters": {"term": {
                    "listingType": ["standard"],
                    "language": ["English"],
                    "printing": ["Holofoil"],
                    "verified-seller": true
                }},
                "from": 0,
                "size": 50,
                "sort": {"field": "price+shipping", "order": "asc"}
            })
        );
        let own =
            serde_json::to_value(ListingsQuery::new(&sku(), Some("Near Mint"), true, 1)).unwrap();
        assert_eq!(
            own["filters"]["term"]["condition"],
            serde_json::json!(["Near Mint"])
        );
        assert!(own["filters"]["term"].get("verified-seller").is_none());
    }

    fn pages(
        total: usize,
        prices: Vec<Vec<f64>>,
    ) -> impl FnMut(ListingsQuery) -> std::future::Ready<Result<ListingsAnswer, tcgplayer::Failure>>
    {
        move |q| {
            let page = prices.get(q.from / q.size).cloned().unwrap_or_default();
            std::future::ready(Ok(ListingsAnswer {
                results: vec![ListingsPage {
                    total_results: total,
                    results: page
                        .into_iter()
                        .enumerate()
                        .map(|(i, p)| ask(i as i64, "Near Mint", p, 0.0, "s"))
                        .collect(),
                }],
            }))
        }
    }

    #[tokio::test]
    async fn listings_page_until_the_total_is_read() {
        let q = ListingsQuery::new(&sku(), None, false, 2);
        let all = all_listings(
            q,
            None,
            pages(5, vec![vec![1.0, 2.0], vec![3.0, 4.0], vec![5.0]]),
        )
        .await
        .unwrap();
        assert_eq!(all.len(), 5);
    }

    #[tokio::test]
    async fn listings_stop_after_the_page_that_passes_the_ceiling() {
        let q = ListingsQuery::new(&sku(), None, false, 2);
        let all = all_listings(
            q,
            Some(3.5),
            pages(6, vec![vec![1.0, 2.0], vec![3.0, 4.0], vec![5.0, 6.0]]),
        )
        .await
        .unwrap();
        // The page holding 4.00 is kept whole; the next is not asked for.
        assert_eq!(
            all.iter().map(|l| l.price).collect::<Vec<_>>(),
            [1.0, 2.0, 3.0, 4.0]
        );
    }

    #[tokio::test]
    async fn an_answer_with_no_result_set_fails_the_fetch() {
        let q = ListingsQuery::new(&sku(), None, false, 50);
        let failed = all_listings(q, None, |_| {
            std::future::ready(Ok(ListingsAnswer::default()))
        })
        .await;
        assert!(failed.is_err());
    }

    #[test]
    fn the_lowest_ask_skips_the_store_and_needs_a_price() {
        let page = [
            ask(1, "Near Mint", 2.0, 0.99, "store"),
            ask(2, "Near Mint", 3.0, 1.0, "other"),
        ];
        assert_eq!(lowest_ask(&page, Some("store")), Some(4.0));
        assert_eq!(lowest_ask(&page, None), Some(2.99));
        assert_eq!(
            lowest_ask(&[ask(3, "Near Mint", 0.0, 0.0, "x")], None),
            None
        );
        assert_eq!(lowest_ask(&[], None), None);
    }

    #[tokio::test]
    async fn pages_of_twenty_five_until_the_maximum() {
        let asked = RefCell::new(Vec::new());
        let all = all_latest_sales(query(), 100, |q| {
            asked.borrow_mut().push((q.offset, q.limit));
            async move {
                Ok(SalesPage {
                    next_page: "Yes".into(),
                    total_results: 500,
                    data: sales(q.limit),
                })
            }
        })
        .await
        .unwrap();
        assert_eq!(all.len(), 100);
        assert_eq!(*asked.borrow(), [(0, 25), (25, 25), (50, 25), (75, 25)]);
    }

    #[tokio::test]
    async fn stops_when_there_is_no_next_page() {
        let asked = RefCell::new(0);
        let all = all_latest_sales(query(), 100, |q| {
            *asked.borrow_mut() += 1;
            let last = q.offset == 25;
            async move {
                Ok(SalesPage {
                    next_page: if last { String::new() } else { "Yes".into() },
                    total_results: 32,
                    data: sales(if last { 7 } else { 25 }),
                })
            }
        })
        .await
        .unwrap();
        assert_eq!((all.len(), *asked.borrow()), (32, 2));
    }

    #[tokio::test]
    async fn the_last_page_asks_only_for_what_is_still_wanted() {
        let asked = RefCell::new(Vec::new());
        all_latest_sales(query(), 30, |q| {
            asked.borrow_mut().push(q.limit);
            async move {
                Ok(SalesPage {
                    next_page: "Yes".into(),
                    total_results: 500,
                    data: sales(q.limit),
                })
            }
        })
        .await
        .unwrap();
        assert_eq!(*asked.borrow(), [25, 5]);
    }

    #[tokio::test]
    async fn a_failed_page_fails_the_fetch() {
        let failed = all_latest_sales(query(), 100, |_| async {
            Err(tcgplayer::Failure::Status(500))
        })
        .await;
        assert_eq!(failed, Err(tcgplayer::Failure::Status(500)));
    }

    #[test]
    fn five_sales_could_be_the_signed_out_view_only_when_more_were_asked_for() {
        assert!(could_be_anonymous(5, 100));
        assert!(!could_be_anonymous(5, 5));
        assert!(!could_be_anonymous(6, 100));
        assert!(!could_be_anonymous(4, 100));
    }

    #[test]
    fn the_request_body_is_named_as_node_sends_it() {
        let body = serde_json::to_value(query()).unwrap();
        assert_eq!(
            body,
            serde_json::json!({
                "conditions": [], "languages": [1], "variants": [11],
                "listingType": "ListingWithoutPhotos", "offset": 0, "limit": 25
            })
        );
    }

    /// One approved live read (decision 32): the dev ledger's busiest product's latest sales and
    /// price history, checked against what the Node app recorded. Writes nothing to the database;
    /// with `LATEST_SALES_FIXTURE` set, saves the sales there with titles and listing ids cleared.
    #[cfg(feature = "live-tcgplayer")]
    #[tokio::test]
    #[ignore = "reads TCGplayer live with the dev database's cookie"]
    async fn live_sales_agree_with_the_ledger() {
        use std::collections::HashSet;

        use chrono::{DateTime, Utc};

        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let tcg = TcgPlayer::new(db.clone());
        let evidence = TcgPlayerEvidence {
            tcg,
            db: db.clone(),
        };
        let (product_id, product_line_id, variant, language): (i32, i32, String, String) =
            sqlx::query_as(
                "SELECT s.product_id, p.product_line_id, s.variant, s.language
                 FROM product_sales s JOIN products p USING (product_id)
                 WHERE s.order_date >= now() - interval '7 days'
                 GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC, 1 LIMIT 1",
            )
            .fetch_one(&db.0)
            .await
            .expect("the ledger has a sale this week");
        let sku = Sku {
            sku: 0,
            product_id: product_id.into(),
            product_line_id: product_line_id.into(),
            condition: "Near Mint".into(),
            variant: variant.clone(),
            language: language.clone(),
        };
        let sales = evidence
            .latest_sales(&sku)
            .await
            .expect("latest sales read");

        type Key = (i64, String, i64, i64, i64);
        let cents = |price: f64| (price * 100.0).round() as i64;
        let ledger: Vec<(DateTime<Utc>, String, i32, f64, f64)> = sqlx::query_as(
            "SELECT order_date, condition, quantity, purchase_price::float8, shipping_price::float8
             FROM product_sales WHERE product_id = $1 AND variant = $2 AND language = $3",
        )
        .bind(product_id)
        .bind(&variant)
        .bind(&language)
        .fetch_all(&db.0)
        .await
        .expect("ledger read");
        let newest = ledger
            .iter()
            .map(|row| row.0.timestamp_millis())
            .max()
            .unwrap_or(0);
        let recorded: HashSet<Key> = ledger
            .into_iter()
            .map(|(at, condition, quantity, price, shipping)| {
                (
                    at.timestamp_millis(),
                    condition,
                    quantity.into(),
                    cents(price),
                    cents(shipping),
                )
            })
            .collect();
        let (mut matched, mut newer, mut missing) = (0, 0, 0);
        for sale in &sales {
            let at = sale.timestamp() as i64;
            let key: Key = (
                at,
                sale.condition.clone(),
                sale.quantity as i64,
                cents(sale.purchase_price),
                cents(sale.shipping_price),
            );
            if recorded.contains(&key) {
                matched += 1;
            } else if at > newest {
                newer += 1;
            } else {
                missing += 1;
            }
        }
        let history = evidence.price_history(product_id.into()).await;
        println!(
            "product {product_id} ({variant}, {language}): {} sales read; {matched} in the ledger, \
             {newer} newer than it, {missing} missing; price history: {:?} SKUs",
            sales.len(),
            history.as_ref().map(Vec::len)
        );
        if let Ok(path) = std::env::var("LATEST_SALES_FIXTURE") {
            let scrubbed: Vec<Sale> = sales
                .iter()
                .map(|sale| Sale {
                    title: String::new(),
                    custom_listing_id: String::new(),
                    ..sale.clone()
                })
                .collect();
            let fixture = serde_json::json!({ "productId": product_id, "variant": variant,
                "language": language, "sales": scrubbed });
            std::fs::write(path, serde_json::to_string_pretty(&fixture).unwrap()).unwrap();
        }
        assert!(
            sales.len() > ANONYMOUS_SALES_LIMIT,
            "full history is visible"
        );
        assert_eq!(missing, 0, "every sale the ledger should hold is in it");
        assert!(history.is_some_and(|h| !h.is_empty()), "price history read");
    }

    #[test]
    fn history_numbers_read_as_javascript_reads_them() {
        let entry: HistorySku = serde_json::from_value(serde_json::json!({
            "skuId": "8123", "condition": "Near Mint", "variant": "Normal", "language": "English",
            "buckets": [{ "marketPrice": "1.25", "transactionCount": "", "bucketStartDate": "2026-10-26" }]
        }))
        .unwrap();
        let history = History::from(&entry);
        assert_eq!(history.sku_id, 8123);
        assert_eq!(history.buckets[0].market_price, 1.25);
        assert_eq!(history.buckets[0].transaction_count, 0.0);
    }
}
