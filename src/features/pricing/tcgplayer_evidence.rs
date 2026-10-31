//! Evidence read live from TCGplayer for the batch pricing shadow: a product's latest sales
//! (`getAllLatestSales`, a read-only POST approved for dev shadow runs) and its annual price history
//! (a GET). Listings and price points are POSTs that are not approved, so supply reads as
//! unavailable and the shadow compares prices that do not lean on competing asks. Nothing read here
//! is recorded: the ledgers stay Node's while the shadow runs.
use std::{future::Future, time::Duration};

use serde::{Deserialize, Serialize};

use super::buyer_arrival_rate::LATEST_SALES_LIMIT;
use super::policy::SupplyStatus;
use super::sale::Sale;
use super::sku_price::{Evidence, Failure, History, HistoryBucket, Sku};
use super::supply_analysis::Observation as Supply;
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
    result: Vec<HistoryEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    sku_id: String,
    condition: String,
    variant: String,
    language: String,
    #[serde(default)]
    buckets: Vec<HistoryEntryBucket>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntryBucket {
    market_price: String,
    transaction_count: String,
    bucket_start_date: String,
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

impl From<HistoryEntry> for History {
    fn from(entry: HistoryEntry) -> Self {
        History {
            sku_id: number(&entry.sku_id) as i64,
            condition: entry.condition,
            variant: entry.variant,
            language: entry.language,
            buckets: entry
                .buckets
                .into_iter()
                .map(|b| HistoryBucket {
                    market_price: number(&b.market_price),
                    transaction_count: number(&b.transaction_count),
                    bucket_start_date: b.bucket_start_date,
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
        Some(answer.result.into_iter().map(History::from).collect())
    }

    async fn listings(&self, _: &Sku, _: Option<f64>, _: Option<&str>) -> Supply {
        Supply {
            status: SupplyStatus::Unavailable,
            listings: Vec::new(),
        }
    }

    async fn lowest_listing_price(&self, _: &Sku, _: Option<&str>) -> Option<f64> {
        None
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
        let entry: HistoryEntry = serde_json::from_value(serde_json::json!({
            "skuId": "8123", "condition": "Near Mint", "variant": "Normal", "language": "English",
            "buckets": [{ "marketPrice": "1.25", "transactionCount": "", "bucketStartDate": "2026-10-26" }]
        }))
        .unwrap();
        let history = History::from(entry);
        assert_eq!(history.sku_id, 8123);
        assert_eq!(history.buckets[0].market_price, 1.25);
        assert_eq!(history.buckets[0].transaction_count, 0.0);
    }
}
