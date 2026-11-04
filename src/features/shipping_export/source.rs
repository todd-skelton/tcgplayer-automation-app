//! Where the orders come from: TCGplayer's Ready to Ship queue or one order, read from its order
//! management API with each line's market price and the configured seller's intake history
//! (`/api/shipping-export/tcgplayer-orders`, `tcgplayerSellerOrders`), and the seller's order
//! history record: how far its scan has got is read, the scan moved on a step (the batch's orders
//! first) and an export imported here (`/api/seller-order-history`).
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    intake_history,
    orders::{Line, Order},
};
use crate::{
    database::Database,
    features::{
        batch_pricing::{job::MarketData, market::TcgPlayerMarket},
        continuous_pricing::refresh::market_prices,
        http_configuration::config::Domain,
        seller_order_history::{self as history, file_import},
        shipping_configuration,
    },
    tcgplayer::{Call, TcgPlayer},
};

/// How far the saved scan of the seller's orders has got.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    /// `running`, `complete`, `incomplete` or `not_started`.
    pub status: String,
    #[serde(default)]
    pub expected_total: Option<u64>,
    #[serde(default)]
    pub orders_observed: u64,
    #[serde(default)]
    pub details_recorded: u64,
    #[serde(default)]
    pub error: Option<String>,
}

impl Coverage {
    /// What the React screen wrote: "API history complete: 120 of 120 orders observed, ...".
    pub fn describe(&self) -> String {
        let total = self
            .expected_total
            .map_or(String::new(), |t| format!(" of {t}"));
        let error = self
            .error
            .as_deref()
            .map_or(String::new(), |e| format!(" {e}"));
        format!(
            "API history {}: {}{total} orders observed, {} details refreshed in the last scan.{error}",
            self.status.replacen('_', " ", 1),
            self.orders_observed,
            self.details_recorded,
        )
    }
}

/// Orders loaded from TCGplayer, with what could not be.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub seller_key: String,
    #[serde(default)]
    pub loaded_order_numbers: Vec<String>,
    pub orders: Vec<Order>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// TCGplayer's order management API, answered as JSON: the order search, and an order's detail.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait OrderManagement {
    async fn search(&self, body: &Value) -> Result<Value, String>;
    async fn order(&self, path: &str) -> Result<Value, String>;
}

/// The API, through the app's TCGplayer client and its rate limits.
pub struct TcgPlayerOrders(pub TcgPlayer);

impl OrderManagement for TcgPlayerOrders {
    async fn search(&self, body: &Value) -> Result<Value, String> {
        self.0
            .post(
                Domain::OrderManagementApi,
                "/orders/search?api-version=2.0",
                body,
                Call::default(),
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn order(&self, path: &str) -> Result<Value, String> {
        self.0
            .get(Domain::OrderManagementApi, path, Call::default())
            .await
            .map_err(|e| e.to_string())
    }
}

/// An order as the search lists it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    order_number: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Found {
    #[serde(default)]
    total_orders: usize,
    #[serde(default)]
    orders: Vec<Summary>,
}

/// An order's detail (`SellerOrderDetail`), what the shipping workflow keeps of it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    order_number: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    shipping_type: String,
    transaction: Transaction,
    shipping_address: Address,
    #[serde(default)]
    products: Vec<Product>,
    #[serde(default)]
    tracking_numbers: Option<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    product_amount: f64,
    shipping_amount: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Address {
    #[serde(default)]
    recipient_name: String,
    address_one: Option<String>,
    address_two: Option<String>,
    city: Option<String>,
    territory: Option<String>,
    postal_code: Option<String>,
    country: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Product {
    name: String,
    quantity: u32,
    unit_price: f64,
    #[serde(default)]
    sku_id: String,
    #[serde(default)]
    product_id: String,
}

fn read<T: serde::de::DeserializeOwned>(answer: Value) -> Result<T, String> {
    serde_json::from_value(answer).map_err(|e| format!("TCGplayer's answer could not be read: {e}"))
}

/// A SKU written as TCGplayer's positive 32-bit SKU ids are (`canonicalNumericSku`).
fn numeric_sku(text: &str) -> Option<i64> {
    let digits = text.len() <= 10
        && text.starts_with(|c: char| ('1'..='9').contains(&c))
        && text.bytes().all(|b| b.is_ascii_digit());
    text.parse::<i64>()
        .ok()
        .filter(|sku| digits && *sku <= 2_147_483_647)
}

/// JavaScript's `Number.parseInt(text, 10) || undefined`: the leading integer, none for 0.
fn leading_integer(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (sign, digits) = match text.as_bytes().first() {
        Some(b'-') => (-1, &text[1..]),
        Some(b'+') => (1, &text[1..]),
        _ => (1, text),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end]
        .parse::<i64>()
        .ok()
        .map(|n| sign * n)
        .filter(|n| *n != 0)
}

/// The first tracking number given, as text or as a record's `trackingNumber`.
fn tracking(entries: Option<&[Value]>) -> String {
    entries
        .into_iter()
        .flatten()
        .filter_map(|entry| match entry {
            Value::Object(record) => record.get("trackingNumber").and_then(Value::as_str),
            other => other.as_str(),
        })
        .map(str::trim)
        .find(|n| !n.is_empty())
        .unwrap_or_default()
        .to_owned()
}

/// The order as the shipping workflow keeps it (`mapSellerOrderDetailToShippingOrder`).
fn shipping_order(d: Detail) -> Order {
    let name = d
        .shipping_address
        .recipient_name
        .split_whitespace()
        .collect::<Vec<_>>();
    let (first_name, last_name) = match name.split_first() {
        Some((first, rest)) => ((*first).to_owned(), rest.join(" ")),
        None => (String::new(), String::new()),
    };
    let text = |v: &Option<String>| v.as_deref().map_or("", str::trim).to_owned();
    let a = &d.shipping_address;
    let country = text(&a.country);
    Order {
        number: d.order_number,
        first_name,
        last_name,
        address1: text(&a.address_one),
        address2: text(&a.address_two),
        city: text(&a.city),
        state: text(&a.territory),
        postal_code: text(&a.postal_code),
        country: if country.is_empty() {
            "US".to_owned()
        } else {
            country
        },
        order_date: d.created_at,
        product_weight: 0.0,
        shipping_method: d.shipping_type,
        item_count: d.products.iter().map(|p| p.quantity).sum(),
        value_of_products: d.transaction.product_amount,
        shipping_fee_paid: d.transaction.shipping_amount,
        tracking_number: tracking(d.tracking_numbers.as_deref()),
        carrier: String::new(),
        products: Some(
            d.products
                .into_iter()
                .map(|p| {
                    let inventory = p.sku_id.trim().to_owned();
                    Line {
                        name: p.name,
                        quantity: p.quantity,
                        unit_price: p.unit_price,
                        sku_id: numeric_sku(&inventory),
                        product_id: leading_integer(&p.product_id),
                        inventory_sku_id: Some(inventory),
                        market_price: None,
                    }
                })
                .collect(),
        ),
        intake_history: None,
    }
}

/// The path of an order's detail, its number written as `encodeURIComponent` writes it.
fn order_path(number: &str) -> String {
    format!(
        "/orders/{}?api-version=2.0",
        history::api::component(number)
    )
}

async fn detail(api: &impl OrderManagement, number: &str) -> Result<Order, String> {
    Ok(shipping_order(read(api.order(&order_path(number)).await?)?))
}

/// The orders asked for each page of the Ready to Ship search.
const PAGE: usize = 500;

/// Every order ready to ship from the last three months, each read in full; one that cannot be
/// read is a warning (`loadSellerShippingOrders`).
async fn ready(
    api: &impl OrderManagement,
    seller_key: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<Order>, String> {
    let mut summaries = Vec::new();
    let mut from = 0;
    loop {
        let body = json!({
            "searchRange": "LastThreeMonths",
            "filters": { "sellerKey": seller_key, "orderStatuses": ["ReadyToShip"] },
            "sortBy": [],
            "from": from,
            "size": PAGE,
        });
        let page: Found = read(api.search(&body).await?)?;
        let empty = page.orders.is_empty();
        summaries.extend(page.orders);
        from += PAGE;
        // An empty page ends it too, where Node would ask again for ever.
        if summaries.len() >= page.total_orders || empty {
            break;
        }
    }
    let details = join_all(summaries.iter().map(|s| detail(api, &s.order_number))).await;
    let mut orders = Vec::new();
    for (summary, detail) in summaries.iter().zip(details) {
        match detail {
            Ok(order) => orders.push(order),
            Err(e) => warnings.push(format!(
                "Failed to load seller order {}: Error: {e}",
                summary.order_number
            )),
        }
    }
    Ok(orders)
}

/// One order by its number, whatever its status (`loadSingleSellerShippingOrder`).
async fn single(
    api: &impl OrderManagement,
    seller_key: &str,
    number: &str,
    warnings: &mut Vec<String>,
) -> Result<Order, String> {
    let body = json!({
        "searchRange": "LastThreeMonths",
        "query": { "orderNumber": number },
        "filters": { "sellerKey": seller_key },
        "sortBy": [
            { "sortingType": "orderStatus", "direction": "ascending" },
            { "sortingType": "orderDate", "direction": "ascending" },
        ],
        "from": 0,
        "size": 25,
    });
    let page: Found = read(api.search(&body).await?)?;
    let summary = page
        .orders
        .into_iter()
        .find(|o| o.order_number == number)
        .ok_or_else(|| format!("Order {number} was not found for seller {seller_key}."))?;
    let detail: Detail = read(api.order(&order_path(&summary.order_number)).await?)?;
    let status: String = detail
        .status
        .split_whitespace()
        .collect::<String>()
        .to_lowercase();
    if status != "readytoship" {
        warnings.push(format!(
            "Order {} is currently \"{}\", not \"Ready to Ship\". Review it before buying postage.",
            detail.order_number, detail.status
        ));
    }
    Ok(shipping_order(detail))
}

/// Each line's market price, when its SKU has one (`attachMarketPricesToOrders`); prices that
/// cannot be read are a warning.
async fn priced(market: &impl MarketData, orders: &mut [Order], warnings: &mut Vec<String>) {
    let skus: Vec<i64> = orders
        .iter()
        .flat_map(|o| o.lines().iter().filter_map(|l| l.sku_id))
        .collect();
    if skus.is_empty() {
        return;
    }
    match market_prices(market, &skus).await {
        Ok(prices) => {
            for line in orders
                .iter_mut()
                .flat_map(|o| o.products.iter_mut().flatten())
            {
                if let Some(price) = line.sku_id.and_then(|sku| prices.get(&sku)) {
                    line.market_price = Some(*price);
                }
            }
        }
        Err(e) => warnings.push(format!(
            "Market prices could not be loaded, so market comparisons are unavailable: Error: {e}"
        )),
    }
}

/// The seller's orders ready to ship, or with `number` that one order, whatever its status (a
/// warning says when it is not ready to ship); an empty key is the shipping settings' seller. The
/// configured seller's orders come with their intake history.
pub async fn load(
    db: &Database,
    api: &impl OrderManagement,
    market: &impl MarketData,
    seller_key: &str,
    number: Option<&str>,
) -> Result<Loaded, String> {
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| format!("Error: {e}"))?;
    let configured = configured.trim();
    let seller_key = match seller_key.trim() {
        "" => configured,
        given => given,
    };
    if seller_key.is_empty() {
        return Err("A seller key is required. Enter one on the shipping page or save a default in Shipping Configuration.".to_owned());
    }
    let mut warnings = Vec::new();
    let mut orders = match number.map(str::trim).filter(|n| !n.is_empty()) {
        Some(number) => vec![single(api, seller_key, number, &mut warnings).await],
        None => ready(api, seller_key, &mut warnings)
            .await
            .map(|orders| orders.into_iter().map(Ok).collect())
            .map_err(|e| format!("Error: {e}"))?,
    }
    .into_iter()
    .collect::<Result<Vec<Order>, String>>()
    .map_err(|e| format!("Error: {e}"))?;
    priced(market, &mut orders, &mut warnings).await;
    if configured.is_empty() || seller_key != configured {
        warnings.push("Intake history is unavailable because this order load does not match the configured seller.".to_owned());
    } else if let Err(e) = intake_history::attach(db, seller_key, &mut orders).await {
        warnings.push(format!("Intake history is unavailable: Error: {e}"));
    }
    Ok(Loaded {
        seller_key: seller_key.to_owned(),
        loaded_order_numbers: orders.iter().map(|o| o.number.clone()).collect(),
        orders,
        warnings,
    })
}

/// The seller's orders, or one of them, read from TCGplayer with each line's market price.
pub async fn from_tcgplayer(
    db: &Database,
    seller_key: &str,
    number: Option<&str>,
) -> Result<Loaded, String> {
    let tcgplayer = TcgPlayer::new(db.clone());
    let orders = TcgPlayerOrders(tcgplayer.clone());
    load(db, &orders, &TcgPlayerMarket(tcgplayer), seller_key, number).await
}

/// A scan as read: its status, the orders it expects, has observed and recorded, and its error.
type Scan = (String, Option<i32>, i32, i32, Option<String>);

/// How far the seller's order history scan has got: its latest API scan (`getCoverage`).
pub async fn coverage(db: impl sqlx::PgExecutor<'_>, seller_key: &str) -> Result<Coverage, String> {
    let row: Option<Scan> = sqlx::query_as(
        "SELECT status, expected_total, orders_observed, details_recorded, error FROM seller_order_sync_runs
         WHERE seller_key = $1 AND source = 'tcgplayer_api' ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(seller_key.trim())
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let count = |n: i32| u64::try_from(n).unwrap_or(0);
    Ok(match row {
        None => Coverage {
            status: "not_started".to_owned(),
            expected_total: None,
            orders_observed: 0,
            details_recorded: 0,
            error: None,
        },
        Some((status, expected, observed, recorded, error)) => Coverage {
            status,
            expected_total: expected.map(count),
            orders_observed: count(observed),
            details_recorded: count(recorded),
            error: error.filter(|e| !e.is_empty()),
        },
    })
}

/// Moves the seller's order history scan on a step, reading these orders from TCGplayer first:
/// the seller named, else the default shipping seller (as the Node route resolves it).
pub async fn catch_up(db: &Database, seller_key: &str, orders: &[String]) -> Result<(), String> {
    history::catch_up::requested(db, seller_key, orders)
        .await
        .map(drop)
}

/// Adds an order export older than the API's three months to the seller's order history: the
/// seller named, else the default shipping seller (as the Node route resolves it).
pub async fn import_history(
    db: &Database,
    seller_key: &str,
    file_name: &str,
    csv_text: &str,
) -> Result<file_import::Imported, String> {
    file_import::requested(db, seller_key, Some(file_name), csv_text)
        .await
        .map(|(_, imported)| imported)
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn coverage_reads_as_the_react_screen_wrote_it() {
        let coverage: Coverage = serde_json::from_value(serde_json::json!({
            "sellerKey": "s", "source": "tcgplayer_api", "status": "not_started",
            "ordersObserved": 3, "detailsRecorded": 1, "expectedTotal": 9
        }))
        .unwrap();
        assert_eq!(
            coverage.describe(),
            "API history not started: 3 of 9 orders observed, 1 details refreshed in the last scan."
        );
    }
}
