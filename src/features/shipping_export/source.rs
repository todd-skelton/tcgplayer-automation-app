//! Where the orders come from: TCGplayer's Ready to Ship queue or one order, read by the Node app
//! (`/api/shipping-export/tcgplayer-orders`), with each order's intake history
//! (`intake-history`) and the seller's order history record (`/api/seller-order-history`).
use serde::{Deserialize, Serialize};

use super::orders::{IntakeHistory, Order};
use crate::legacy::Legacy;

/// The most orders the intake history is read for at once, as the Node route takes.
const MOST_FOR_HISTORY: usize = 500;

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

/// Orders the Node app loaded.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub seller_key: String,
    #[serde(default)]
    pub loaded_order_numbers: Vec<String>,
    pub orders: Vec<Order>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ask<'a> {
    seller_key: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    order_number: Option<&'a str>,
}

/// The seller's orders ready to ship; an empty key is the shipping settings' seller.
pub async fn ready_to_ship(legacy: &Legacy, seller_key: &str) -> Result<Loaded, String> {
    legacy
        .send(
            "/api/shipping-export/tcgplayer-orders",
            &Ask {
                seller_key,
                order_number: None,
            },
        )
        .await
}

/// One order, whatever its status (a warning says when it is not ready to ship).
pub async fn one(legacy: &Legacy, seller_key: &str, number: &str) -> Result<Loaded, String> {
    legacy
        .send(
            "/api/shipping-export/tcgplayer-orders",
            &Ask {
                seller_key,
                order_number: Some(number),
            },
        )
        .await
}

/// The orders' intake history read again (the Node route checks the seller is the configured
/// one); an order it has none for gets none.
pub async fn intake_history(
    legacy: &Legacy,
    seller_key: &str,
    orders: &mut [Order],
) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Line {
        quantity: u32,
        unit_price: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        sku_id: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        inventory_sku_id: Option<String>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Asked {
        order_number: String,
        order_date: String,
        item_count: u32,
        value_of_products: f64,
        products: Vec<Line>,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        seller_key: &'a str,
        orders: Vec<Asked>,
    }
    #[derive(Deserialize)]
    struct Answer {
        histories: Vec<IntakeHistory>,
    }
    if orders.is_empty() {
        return Ok(());
    }
    if orders.len() > MOST_FOR_HISTORY {
        return Err(format!(
            "Intake history is read for at most {MOST_FOR_HISTORY} orders."
        ));
    }
    let request = Request {
        seller_key,
        orders: orders
            .iter()
            .map(|o| Asked {
                order_number: o.number.clone(),
                order_date: o.order_date.clone(),
                item_count: o.item_count,
                value_of_products: o.value_of_products,
                products: o
                    .lines()
                    .iter()
                    .map(|l| Line {
                        quantity: l.quantity,
                        unit_price: l.unit_price,
                        sku_id: l.sku_id,
                        inventory_sku_id: l.inventory_sku_id.clone(),
                    })
                    .collect(),
            })
            .collect(),
    };
    let answer: Answer = legacy
        .send("/api/shipping-export/intake-history", &request)
        .await?;
    if answer
        .histories
        .iter()
        .any(|h| h.seller_key != seller_key.trim())
    {
        return Err("Intake history response seller does not match the loaded workflow.".into());
    }
    for order in orders.iter_mut() {
        order.intake_history = answer
            .histories
            .iter()
            .find(|h| h.order_number == order.number)
            .cloned();
    }
    Ok(())
}

/// How far the seller's order history scan has got.
pub async fn coverage(legacy: &Legacy, seller_key: &str) -> Result<Coverage, String> {
    #[derive(Deserialize)]
    struct Answer {
        coverage: Coverage,
    }
    let answer: Answer = legacy
        .read_with("/api/seller-order-history", &[("sellerKey", seller_key)])
        .await?;
    Ok(answer.coverage)
}

/// Moves the seller's order history scan on, these orders first.
pub async fn catch_up(legacy: &Legacy, seller_key: &str, orders: &[String]) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        seller_key: &'a str,
        action: &'static str,
        order_numbers: &'a [String],
    }
    legacy
        .send::<_, serde_json::Value>(
            "/api/seller-order-history",
            &Request {
                seller_key,
                action: "catch_up",
                order_numbers: orders,
            },
        )
        .await
        .map(drop)
}

/// Adds an order export older than the API's three months to the seller's order history.
pub async fn import_history(
    legacy: &Legacy,
    seller_key: &str,
    file_name: &str,
    csv_text: &str,
) -> Result<(), String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        seller_key: &'a str,
        action: &'static str,
        csv_text: &'a str,
        file_name: &'a str,
    }
    legacy
        .send::<_, serde_json::Value>(
            "/api/seller-order-history",
            &Request {
                seller_key,
                action: "import_csv",
                csv_text,
                file_name,
            },
        )
        .await
        .map(drop)
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
