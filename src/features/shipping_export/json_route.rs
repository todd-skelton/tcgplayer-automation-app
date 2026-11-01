//! `POST /api/shipping-export/intake-history`: what the shipping orders' cards cost when they came
//! into inventory and how long they were held, for the configured seller, as the Node route
//! answered it (`createShippingIntakeHistoryAction`).
//!
//! Where it can still differ from Node, each on a request the Node app's own client never sends:
//! an order date `Date.parse` reads but RFC 3339 and a plain date do not is a `mismatch` here; a
//! count past 4,294,967,295 is refused as incomplete; and a text `skuId` with spaces around it is
//! read trimmed, where Node kept the spaces and so found no allocation for it.
use corten::{
    Api, JsonResponse, Prefix,
    axum::{body::to_bytes, extract::Request, http::StatusCode},
    prelude::*,
};
use serde_json::{Value, json};

use super::{
    intake_history::{self, MOST_ORDERS},
    orders::{IntakeHistory, Line, Order},
};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{inventory_economics::ledger::fingerprint::js_float, shipping_configuration},
};

/// The largest body read: 500 orders and their lines.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

#[derive(Route)]
#[route("/api/shipping-export/intake-history")]
pub struct ShippingIntakeHistory;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<ShippingIntakeHistory>(post(refresh).with_state(shared.clone()))
}

/// Why a request was refused: Node's status and message.
type Refused = (StatusCode, String);

/// `{ histories }`, one for each order asked, or Node's refusal.
async fn refresh(State(db): State<Database>, request: Request) -> JsonResponse {
    let read = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => histories(&db, &body).await,
        Err(error) => Err((StatusCode::BAD_REQUEST, format!("Error: {error}"))),
    };
    match read {
        Ok(histories) => api::node_json(&json!({ "histories": histories })),
        Err((status, message)) => api::error(status, message),
    }
}

async fn histories(db: &Database, body: &[u8]) -> Result<Vec<IntakeHistory>, Refused> {
    let bad = |message: String| (StatusCode::BAD_REQUEST, message);
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| bad(format!("SyntaxError: {e}")))?;
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| bad(format!("Error: {e}")))?;
    if payload.is_null() {
        return Err(bad(
            "TypeError: Cannot read properties of null (reading 'sellerKey')".into(),
        ));
    }
    let seller = api::js_trim(&configured);
    let requested = payload.get("sellerKey").and_then(Value::as_str);
    let requested = requested.map(api::js_trim).unwrap_or_default();
    if seller.is_empty() {
        let message = "A configured seller key is required to refresh intake history.";
        return Err(bad(message.into()));
    }
    if !requested.is_empty() && requested != seller {
        let message = "The intake history seller does not match Shipping Configuration.";
        return Err((StatusCode::FORBIDDEN, message.into()));
    }
    let asked = asked_orders(payload.get("orders")).map_err(|e| bad(format!("Error: {e}")))?;
    let mut orders = asked
        .iter()
        .map(AskedOrder::order)
        .collect::<Result<Vec<_>, _>>()
        .map_err(bad)?;
    intake_history::attach(db, seller, &mut orders)
        .await
        .map_err(|e| bad(format!("Error: {e}")))?;
    Ok(orders
        .into_iter()
        .filter_map(|order| order.intake_history)
        .collect())
}

/// An order as the request names it (`ShippingIntakeHistoryRequestOrder`), its lines as sent.
struct AskedOrder<'a> {
    number: &'a str,
    date: &'a str,
    item_count: u32,
    value_of_products: f64,
    products: Vec<(u32, f64, &'a Value)>,
}

/// `parseOrders`: every order and line whole, or the first thing missing.
fn asked_orders(orders: Option<&Value>) -> Result<Vec<AskedOrder<'_>>, String> {
    match orders {
        Some(Value::Array(orders)) if orders.len() <= MOST_ORDERS => {
            orders.iter().map(asked_order).collect()
        }
        _ => Err(format!("Orders must contain at most {MOST_ORDERS} items.")),
    }
}

/// JavaScript's `typeof value === "object"` for a value that is not null.
fn is_object(value: &Value) -> bool {
    matches!(value, Value::Object(_) | Value::Array(_))
}

/// A whole number, as `Number.isInteger` reads one, that fits a count.
fn whole(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && *n <= f64::from(u32::MAX))
}

fn asked_order(item: &Value) -> Result<AskedOrder<'_>, String> {
    if !is_object(item) {
        return Err("Each history order must be an object.".into());
    }
    let incomplete = || "History order identity is incomplete.".to_owned();
    let number = item
        .get("orderNumber")
        .and_then(Value::as_str)
        .map(api::js_trim);
    let number = number.filter(|n| !n.is_empty()).ok_or_else(incomplete)?;
    let date = item
        .get("orderDate")
        .and_then(Value::as_str)
        .ok_or_else(incomplete)?;
    let item_count = whole(item.get("itemCount"))
        .filter(|n| *n >= 0.0)
        .ok_or_else(incomplete)?;
    let value_of_products = item.get("valueOfProducts").and_then(Value::as_f64);
    let value_of_products = value_of_products
        .filter(|v| *v >= 0.0)
        .ok_or_else(incomplete)?;
    let Some(Value::Array(products)) = item.get("products") else {
        return Err(incomplete());
    };
    let products = products
        .iter()
        .map(|product| {
            if !is_object(product) {
                return Err("History product identity is incomplete.".to_owned());
            }
            let quantity = whole(product.get("quantity")).filter(|q| *q > 0.0);
            let unit_price = product.get("unitPrice").and_then(Value::as_f64);
            match (quantity, unit_price.filter(|p| *p >= 0.0)) {
                (Some(quantity), Some(unit_price)) => Ok((quantity as u32, unit_price, product)),
                _ => Err("History product quantity or sale value is incomplete.".to_owned()),
            }
        })
        .collect::<Result<_, _>>()?;
    Ok(AskedOrder {
        number,
        date,
        item_count: item_count as u32,
        value_of_products,
        products,
    })
}

impl AskedOrder<'_> {
    /// The shipping order Node made of it to read the history against, with no buyer.
    fn order(&self) -> Result<Order, String> {
        let products = self
            .products
            .iter()
            .map(|(quantity, unit_price, product)| {
                Ok(Line {
                    name: String::new(),
                    quantity: *quantity,
                    unit_price: *unit_price,
                    sku_id: None,
                    product_id: None,
                    inventory_sku_id: inventory_identity(product)?,
                    market_price: None,
                })
            })
            .collect::<Result<_, String>>()?;
        Ok(Order {
            number: self.number.to_owned(),
            first_name: String::new(),
            last_name: String::new(),
            address1: String::new(),
            address2: String::new(),
            city: String::new(),
            state: String::new(),
            postal_code: String::new(),
            country: "US".into(),
            order_date: self.date.to_owned(),
            product_weight: 0.0,
            shipping_method: "Standard".into(),
            item_count: self.item_count,
            value_of_products: self.value_of_products,
            shipping_fee_paid: 0.0,
            tracking_number: String::new(),
            carrier: String::new(),
            products: Some(products),
            intake_history: None,
        })
    }
}

/// `shippingInventorySkuId` as Node ran it on the line sent: its `inventorySkuId` when that has
/// text, else its `skuId` as `String` writes it. The line's own reading trims what is returned.
fn inventory_identity(product: &Value) -> Result<Option<String>, String> {
    match product.get("inventorySkuId") {
        None | Some(Value::Null) => {}
        Some(Value::String(id)) if !api::js_trim(id).is_empty() => {
            return Ok(Some(api::js_trim(id).to_owned()));
        }
        Some(Value::String(_)) => {}
        Some(_) => return Err("TypeError: line.inventorySkuId?.trim is not a function".into()),
    }
    Ok(product.get("skuId").map(js_string))
}

/// JavaScript's `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_float(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{inventory_identity, js_string};

    /// Each request `.port-logs/api/shipping-intake-history.cases.json` asked the Node route
    /// (orders the dev seller has, as loaded and changed, and every refusal) gets Node's answer.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        let refreshed: Vec<String> = (0..500)
            .map(|i| format!("/histories/{i}/refreshedAt"))
            .collect();
        let refreshed: Vec<&str> = refreshed.iter().map(String::as_str).collect();
        crate::api::tests::answers_as_node("shipping-intake-history", &refreshed).await;
    }

    #[test]
    fn a_line_is_known_by_the_identity_node_read() {
        let identity = |line| inventory_identity(&line).unwrap();
        assert_eq!(
            identity(json!({ "inventorySkuId": " 12 ", "skuId": 3 })),
            Some("12".into())
        );
        assert_eq!(
            identity(json!({ "inventorySkuId": " ", "skuId": 3 })),
            Some("3".into())
        );
        assert_eq!(identity(json!({ "inventorySkuId": null })), None);
        assert!(inventory_identity(&json!({ "inventorySkuId": 5 })).is_err());
        for (value, text) in [
            (json!(null), "null"),
            (json!(true), "true"),
            (json!(1.5), "1.5"),
            (json!(1e21), "1e+21"),
            (json!([1, null, "a"]), "1,,a"),
            (json!({}), "[object Object]"),
        ] {
            assert_eq!(js_string(&value), text);
        }
    }
}
