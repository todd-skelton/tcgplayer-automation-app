//! The seller's orders as the Node app loads them from TCGplayer (`TcgPlayerShippingOrder` in
//! `types/shippingExport.ts`). The field names are the order CSV's, as the Node app sends them,
//! so a workflow saved here reads the same JSON its routes answer with.
use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Order {
    #[serde(rename = "Order #")]
    pub number: String,
    #[serde(rename = "FirstName")]
    pub first_name: String,
    #[serde(rename = "LastName")]
    pub last_name: String,
    #[serde(rename = "Address1")]
    pub address1: String,
    #[serde(rename = "Address2", default)]
    pub address2: String,
    #[serde(rename = "City")]
    pub city: String,
    #[serde(rename = "State")]
    pub state: String,
    /// A CSV gives a number, the API text; both are kept as text.
    #[serde(rename = "PostalCode", deserialize_with = "text_or_number")]
    pub postal_code: String,
    #[serde(rename = "Country", default)]
    pub country: String,
    #[serde(rename = "Order Date")]
    pub order_date: String,
    #[serde(rename = "Product Weight", default)]
    pub product_weight: f64,
    /// `Standard...` or `Expedited...`.
    #[serde(rename = "Shipping Method")]
    pub shipping_method: String,
    #[serde(rename = "Item Count")]
    pub item_count: u32,
    /// Dollars.
    #[serde(rename = "Value Of Products")]
    pub value_of_products: f64,
    #[serde(rename = "Shipping Fee Paid", default)]
    pub shipping_fee_paid: f64,
    #[serde(rename = "Tracking #", default)]
    pub tracking_number: String,
    #[serde(rename = "Carrier", default)]
    pub carrier: String,
    /// The lines, when the order was loaded from the API.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub products: Option<Vec<Line>>,
    #[serde(
        rename = "intakeHistory",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub intake_history: Option<IntakeHistory>,
}

impl Order {
    pub fn expedited(&self) -> bool {
        self.shipping_method.starts_with("Expedited")
    }

    pub fn recipient(&self) -> String {
        format!("{} {}", self.first_name, self.last_name)
            .trim()
            .to_owned()
    }

    pub fn lines(&self) -> &[Line] {
        self.products.as_deref().unwrap_or_default()
    }

    /// When it was placed, for putting the oldest first; an order date the Node app sends is
    /// ISO 8601, a CSV's may be a plain date.
    pub fn placed_at(&self) -> Option<i64> {
        let date = self.order_date.trim();
        DateTime::parse_from_rfc3339(date)
            .map(|at| at.timestamp_millis())
            .ok()
            .or_else(|| {
                NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|at| at.and_utc().timestamp_millis())
            })
    }
}

/// One product line of an order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub name: String,
    pub quantity: u32,
    /// Dollars.
    pub unit_price: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sku_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_id: Option<i64>,
    /// The provider's own SKU identity, which the intake history is kept by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory_sku_id: Option<String>,
    /// The TCGplayer market price when the order was loaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub market_price: Option<f64>,
}

impl Line {
    /// The SKU the intake history knows the line by (`shippingInventorySkuId`).
    pub fn inventory_sku(&self) -> Option<String> {
        match self.inventory_sku_id.as_deref().map(str::trim) {
            Some(id) if !id.is_empty() => Some(id.to_owned()),
            _ => self.sku_id.map(|id| id.to_string()),
        }
    }

    pub fn sold(&self) -> f64 {
        self.unit_price * f64::from(self.quantity)
    }
}

/// What the order's cards cost when they came into inventory and how long they were held, as the
/// Node app's intake history answers it. Only what the sale value reads is kept.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeHistory {
    pub order_number: String,
    pub seller_key: String,
    pub lines: Vec<IntakeLine>,
    pub refreshed_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeLine {
    pub sku_id: String,
    /// `current` when the history matches the order as it is now.
    pub status: String,
    pub sold_total: Option<f64>,
    pub ordered_quantity: u32,
    pub price_known_quantity: u32,
    pub date_known_quantity: u32,
    pub intake_market_total: Option<f64>,
    pub weighted_days_held: Option<f64>,
}

fn text_or_number<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Either {
        Text(String),
        Number(serde_json::Number),
    }
    Ok(match Either::deserialize(d)? {
        Either::Text(text) => text,
        Either::Number(number) => number.to_string(),
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// An order as the React tests make one (`createOrder`).
    pub fn order(number: &str) -> Order {
        Order {
            number: number.into(),
            first_name: "Jane".into(),
            last_name: "Doe".into(),
            address1: "123 Main St".into(),
            address2: String::new(),
            city: "Dallas".into(),
            state: "TX".into(),
            postal_code: "75001".into(),
            country: "US".into(),
            order_date: "2026-04-11".into(),
            product_weight: 0.0,
            shipping_method: "Standard".into(),
            item_count: 3,
            value_of_products: 10.0,
            shipping_fee_paid: 1.27,
            tracking_number: String::new(),
            carrier: String::new(),
            products: None,
            intake_history: None,
        }
    }

    #[test]
    fn an_order_reads_the_node_apps_json() {
        let json = serde_json::json!({
            "Order #": "B4F0-1", "FirstName": "Ann", "LastName": "Lee", "Address1": "1 Elm",
            "Address2": "", "City": "Wichita", "State": "KS", "PostalCode": 6720,
            "Country": "US", "Order Date": "2026-10-01T15:04:05.000Z", "Product Weight": 0,
            "Shipping Method": "Standard (7-10 days)", "Item Count": 2, "Value Of Products": 3.5,
            "Shipping Fee Paid": 1.31, "Tracking #": "", "Carrier": "",
            "products": [{ "name": "Pikachu", "quantity": 2, "unitPrice": 1.75, "skuId": 123,
                "inventorySkuId": "123", "marketPrice": 1.5 }]
        });
        let order: Order = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(order.postal_code, "6720");
        assert_eq!(order.lines()[0].inventory_sku().as_deref(), Some("123"));
        assert_eq!(order.placed_at(), Some(1_790_867_045_000));
        let back = serde_json::to_value(&order).unwrap();
        assert_eq!(back["Order #"], json["Order #"]);
        assert_eq!(
            back["products"][0]["unitPrice"],
            json["products"][0]["unitPrice"]
        );
    }
}
