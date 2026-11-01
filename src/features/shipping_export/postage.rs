//! Postage: what was bought for each shipment, read from its record (`postage-lookups`), and
//! what a purchase did. Buying it from EasyPost is [`super::purchase`]'s. The mode (test or
//! production) follows the deployment, as it did on the Node app.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{
    one_at_a_time::OneAtATime,
    shipments::{Direction, Planned},
};
use crate::features::shipping_configuration::EasyPostMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Purchased,
    Failed,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rate {
    pub service: String,
    /// Dollars, as EasyPost writes them (`"4.52"`).
    pub rate: String,
    pub currency: String,
}

/// What a purchase did for one shipment.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Purchase {
    pub reference: String,
    #[serde(default)]
    pub order_numbers: Vec<String>,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub easypost_shipment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_rate: Option<Rate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_pdf_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A purchase and the mode it was bought in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bought {
    pub mode: EasyPostMode,
    pub result: Purchase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchased_at: Option<String>,
}

impl Bought {
    pub fn purchased(&self) -> bool {
        self.result.status == Status::Purchased
    }

    /// A label bought in `mode`: buying again pays for a second one.
    pub fn bought_in(&self, mode: EasyPostMode) -> bool {
        self.purchased() && self.mode == mode
    }

    /// Bought for real: what tracking and buyers' messages are sent for.
    pub fn in_production(&self) -> Option<&Purchase> {
        (self.mode == EasyPostMode::Production && self.purchased()).then_some(&self.result)
    }

    /// The label to print: the PDF when EasyPost made one.
    pub fn label(&self) -> Option<&str> {
        self.result
            .label_pdf_url
            .as_deref()
            .or(self.result.label_url.as_deref())
    }
}

/// Postage by shipment reference.
pub type Postage = HashMap<String, Bought>;

/// Postage is bought one purchase at a time, across tabs and computers, as the React screen
/// bought it one at a time in a tab, so two clicks cannot pay twice.
pub static BUYING: OneAtATime = OneAtATime::new();

/// Adds new results over old ones; a skip does not hide a purchase made before it.
pub fn merge(into: &mut Postage, mode: EasyPostMode, results: Vec<Purchase>) {
    for result in results {
        if result.status == Status::Skipped
            && into.get(&result.reference).is_some_and(Bought::purchased)
        {
            continue;
        }
        into.insert(
            result.reference.clone(),
            Bought {
                mode,
                result,
                purchased_at: None,
            },
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BatchLabelStatus {
    Ready,
    Pending,
    Failed,
    Skipped,
}

/// One PDF of every label of a size, made after they are bought.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchLabel {
    pub status: BatchLabelStatus,
    #[serde(default)]
    pub shipment_references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Every shipment of a label size, and one PDF of their labels.
    Bulk,
    Single,
}

/// What a purchase did: its mode, each shipment's result and the batch PDF of its labels.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    pub mode: EasyPostMode,
    pub batch_label: BatchLabel,
    pub results: Vec<Purchase>,
}

/// A successful purchase as recorded (`shipping_postage_purchases`), newest first.
#[derive(sqlx::FromRow)]
struct Record {
    order_numbers: Vec<String>,
    mode: String,
    easypost_shipment_id: Option<String>,
    tracking_code: Option<String>,
    selected_rate_service: Option<String>,
    selected_rate_rate: Option<String>,
    selected_rate_currency: Option<String>,
    label_url: Option<String>,
    label_pdf_url: Option<String>,
    /// As JavaScript's `toISOString` writes it.
    purchased_at: String,
}

/// Orders trimmed, without blanks or repeats, in order: how purchases are matched.
fn order_key(orders: &[String]) -> Vec<String> {
    let mut key: Vec<String> = orders
        .iter()
        .map(|n| n.trim().to_owned())
        .filter(|n| !n.is_empty())
        .collect();
    key.sort();
    key.dedup();
    key
}

fn nonblank(text: Option<String>) -> Option<String> {
    text.filter(|t| !t.is_empty())
}

/// The postage already bought for each shipment, keyed by the shipment (`/api/shipping-export/postage-lookups`):
/// the newest purchase of exactly its orders, else, for a shipment of one order, the newest that
/// carried that order.
pub async fn bought(
    db: impl sqlx::PgExecutor<'_>,
    direction: Direction,
    shipments: &[Planned],
) -> Result<Postage, String> {
    if shipments.is_empty() {
        return Ok(Postage::new());
    }
    let asked: Option<Vec<(&str, Vec<String>)>> = shipments
        .iter()
        .map(|p| {
            let orders: Vec<String> = p
                .orders
                .iter()
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .collect();
            let reference = p.reference().trim();
            (!reference.is_empty() && !orders.is_empty()).then_some((reference, orders))
        })
        .collect();
    let Some(asked) = asked else {
        return Err(
            "Each shipment lookup must include a shipmentReference and one or more order numbers."
                .to_owned(),
        );
    };
    let every: Vec<String> = asked.iter().flat_map(|(_, o)| o.iter().cloned()).collect();
    let direction = match direction {
        Direction::Outbound => "outbound",
        Direction::Return => "return",
    };
    let records: Vec<Record> = sqlx::query_as(
        r#"SELECT order_numbers, mode, easypost_shipment_id, tracking_code, selected_rate_service,
                  selected_rate_rate, selected_rate_currency, label_url, label_pdf_url,
                  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS purchased_at
           FROM shipping_postage_purchases
           WHERE direction = $1 AND status = 'purchased' AND order_numbers && $2::text[]
           ORDER BY created_at DESC, id DESC"#,
    )
    .bind(direction)
    .bind(&every)
    .fetch_all(db)
    .await
    .map_err(|e| format!("Error: {e}"))?;
    let keyed: Vec<Vec<String>> = records
        .iter()
        .map(|r| order_key(&r.order_numbers))
        .collect();
    let mut postage = Postage::new();
    for (reference, orders) in asked {
        let key = order_key(&orders);
        let exact = keyed.iter().position(|k| *k == key);
        let found = exact.or_else(|| match key.as_slice() {
            [one] => keyed.iter().position(|k| k.contains(one)),
            _ => None,
        });
        let Some(record) = found.map(|i| &records[i]) else {
            continue;
        };
        let mode = match record.mode.as_str() {
            "production" => EasyPostMode::Production,
            _ => EasyPostMode::Test,
        };
        let rate = match (
            nonblank(record.selected_rate_service.clone()),
            nonblank(record.selected_rate_rate.clone()),
            nonblank(record.selected_rate_currency.clone()),
        ) {
            (Some(service), Some(rate), Some(currency)) => Some(Rate {
                service,
                rate,
                currency,
            }),
            _ => None,
        };
        let result = Purchase {
            reference: reference.to_owned(),
            order_numbers: orders,
            status: Status::Purchased,
            easypost_shipment_id: record.easypost_shipment_id.clone(),
            tracking_code: record.tracking_code.clone(),
            selected_rate: rate,
            label_url: record.label_url.clone(),
            label_pdf_url: record.label_pdf_url.clone(),
            error: None,
        };
        // A later shipment with the same reference replaces an earlier one, as the React screen
        // keyed its results.
        postage.insert(
            reference.to_owned(),
            Bought {
                mode,
                result,
                purchased_at: Some(record.purchased_at.clone()),
            },
        );
    }
    Ok(postage)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::features::{
        shipping_configuration::ShippingConfig,
        shipping_export::{
            orders::tests::order,
            shipments::{Shipment, shipment_for},
        },
    };

    /// Node's `createShippingPostageLookupsAction` over the cases in `.port-logs/lookups.node.json`,
    /// with the purchases `lookups-seed.sql` records, in a transaction on the dev database that is
    /// rolled back: the postage found for each shipment, and refusals.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn postage_is_found_as_node_finds_it() {
        crate::config::load_env();
        let db = crate::database::Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("lookups-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("lookups.node.json")).unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("lookups-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = theirs["name"].as_str().unwrap();
            let direction: Direction = serde_json::from_value(case["direction"].clone()).unwrap();
            let shipments: Vec<Planned> = case["shipments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| Planned {
                    shipment: Shipment {
                        reference: s["shipmentReference"].as_str().unwrap().to_owned(),
                        ..shipment_for(&order("A"), &ShippingConfig::default())
                    },
                    orders: serde_json::from_value(s["orderNumbers"].clone()).unwrap(),
                })
                .collect();
            let ours = bought(&mut *tx, direction, &shipments).await;
            let expected = match theirs["status"].as_u64().unwrap() {
                200 => Ok(theirs["body"]["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|found| {
                        (
                            found["shipmentReference"].as_str().unwrap().to_owned(),
                            Bought {
                                mode: serde_json::from_value(found["mode"].clone()).unwrap(),
                                result: serde_json::from_value(found["result"].clone()).unwrap(),
                                purchased_at: found["purchasedAt"].as_str().map(str::to_owned),
                            },
                        )
                    })
                    .collect::<Postage>()),
                _ => Err(theirs["body"]["error"].as_str().unwrap().to_owned()),
            };
            assert_eq!(ours, expected, "{name}");
        }
        tx.rollback().await.unwrap();
    }

    fn purchase(reference: &str, status: Status) -> Purchase {
        Purchase {
            reference: reference.into(),
            order_numbers: vec![reference.into()],
            status,
            easypost_shipment_id: None,
            tracking_code: None,
            selected_rate: None,
            label_url: None,
            label_pdf_url: None,
            error: None,
        }
    }

    #[test]
    fn a_skip_does_not_hide_an_earlier_purchase() {
        let mut postage = Postage::new();
        merge(
            &mut postage,
            EasyPostMode::Test,
            vec![
                purchase("A", Status::Purchased),
                purchase("B", Status::Failed),
            ],
        );
        merge(
            &mut postage,
            EasyPostMode::Test,
            vec![
                purchase("A", Status::Skipped),
                purchase("B", Status::Skipped),
            ],
        );
        assert_eq!(postage["A"].result.status, Status::Purchased);
        assert_eq!(postage["B"].result.status, Status::Skipped);
    }

    #[test]
    fn a_lookup_result_reads_the_node_apps_json() {
        let json = serde_json::json!({
            "mode": "production",
            "result": { "reference": "A", "orderNumbers": ["A"], "status": "purchased",
                "trackingCode": "9400", "easypostShipmentId": "shp_1",
                "selectedRate": { "service": "First", "rate": "4.52", "currency": "USD" } },
            "purchasedAt": "2026-10-01T00:00:00.000Z"
        });
        let bought: Bought = serde_json::from_value(json).unwrap();
        assert_eq!(
            bought
                .in_production()
                .and_then(|p| p.tracking_code.as_deref()),
            Some("9400")
        );
    }
}
