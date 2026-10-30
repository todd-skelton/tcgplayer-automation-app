//! Postage, which the Node app buys from EasyPost and records (`/api/shipping-export/postages`,
//! `postage-lookups` and `batch-labels`). The mode (test or production) is the Node app's
//! deployment's, as it is here.
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};

use super::shipments::{Direction, Planned};
use crate::{
    features::shipping_configuration::{EasyPostMode, LabelSize},
    legacy::Legacy,
};

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

static BUYING: AtomicBool = AtomicBool::new(false);

/// The one purchase running: postage is bought one purchase at a time, across tabs and
/// computers, as the React screen bought it one at a time in a tab, so two clicks cannot pay twice.
pub struct Buying(());

impl Buying {
    /// The purchase, or none while another runs.
    pub fn start() -> Option<Buying> {
        BUYING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Buying(()))
    }
}

impl Drop for Buying {
    fn drop(&mut self) {
        BUYING.store(false, Ordering::Release);
    }
}

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bill {
    pub mode: EasyPostMode,
    pub batch_label: BatchLabel,
    pub results: Vec<Purchase>,
}

/// Buys postage for shipments of one label size.
pub async fn buy(
    legacy: &Legacy,
    label_size: LabelSize,
    direction: Direction,
    scope: Scope,
    shipments: &[Planned],
) -> Result<Bill, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        label_size: LabelSize,
        direction: Direction,
        purchase_scope: Scope,
        shipments: &'a [Planned],
    }
    legacy
        .send(
            "/api/shipping-export/postages",
            &Request {
                label_size,
                direction,
                purchase_scope: scope,
                shipments,
            },
        )
        .await
}

/// The postage already bought for each shipment (by exactly its orders, or one order's postage
/// bought alone), keyed by the shipment.
pub async fn bought(
    legacy: &Legacy,
    direction: Direction,
    shipments: &[Planned],
) -> Result<Postage, String> {
    if shipments.is_empty() {
        return Ok(Postage::new());
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Item<'a> {
        shipment_reference: &'a str,
        order_numbers: &'a [String],
    }
    #[derive(Serialize)]
    struct Request<'a> {
        direction: Direction,
        shipments: Vec<Item<'a>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Found {
        shipment_reference: String,
        mode: EasyPostMode,
        purchased_at: String,
        result: Purchase,
    }
    #[derive(Deserialize)]
    struct Answer {
        results: Vec<Found>,
    }
    let request = Request {
        direction,
        shipments: shipments
            .iter()
            .map(|p| Item {
                shipment_reference: p.reference(),
                order_numbers: &p.orders,
            })
            .collect(),
    };
    let answer: Answer = legacy
        .send("/api/shipping-export/postage-lookups", &request)
        .await?;
    Ok(answer
        .results
        .into_iter()
        .map(|found| {
            (
                found.shipment_reference,
                Bought {
                    mode: found.mode,
                    result: found.result,
                    purchased_at: Some(found.purchased_at),
                },
            )
        })
        .collect())
}

/// One PDF of labels already bought, all in one mode.
pub async fn batch_label(
    legacy: &Legacy,
    mode: EasyPostMode,
    label_size: LabelSize,
    labels: &[(&str, &str)],
) -> Result<BatchLabel, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Item<'a> {
        shipment_reference: &'a str,
        easypost_shipment_id: &'a str,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        mode: EasyPostMode,
        label_size: LabelSize,
        shipments: Vec<Item<'a>>,
    }
    let request = Request {
        mode,
        label_size,
        shipments: labels
            .iter()
            .map(|(reference, id)| Item {
                shipment_reference: reference,
                easypost_shipment_id: id,
            })
            .collect(),
    };
    legacy
        .send("/api/shipping-export/batch-labels", &request)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn one_purchase_runs_at_a_time() {
        let first = Buying::start().expect("no purchase is running");
        assert!(Buying::start().is_none(), "a second waits for the first");
        drop(first);
        assert!(Buying::start().is_some(), "the first is over");
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
