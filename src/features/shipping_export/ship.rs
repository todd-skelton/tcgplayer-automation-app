//! Marking orders shipped: their tracking applied on TCGplayer, then their buyers told
//! (`/api/shipping-export/tcgplayer-tracking` and `tcgplayer-shipped-messages`). Only production
//! postage is real, so only it is sent. What is still to send is worked out from what was sent,
//! so sending again after a lost answer or a reload reaches only what has not gone.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::{
    orders::Order,
    postage::{Postage, Purchase},
    shipments::Planned,
};
use crate::legacy::Legacy;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    pub order_number: String,
    pub carrier: String,
    pub tracking_number: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tracked {
    pub order_number: String,
    #[serde(default)]
    pub carrier: String,
    #[serde(default)]
    pub tracking_number: String,
    /// `applied` or `failed`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub order_number: String,
    pub seller_key: String,
    pub easypost_shipment_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Messaged {
    pub order_number: String,
    #[serde(default)]
    pub seller_key: String,
    #[serde(default)]
    pub easypost_shipment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_url: Option<String>,
    /// `sent` or `failed`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Something with an order number, for keeping one result per order.
pub trait ForOrder {
    fn order_number(&self) -> &str;
}

impl ForOrder for Tracked {
    fn order_number(&self) -> &str {
        &self.order_number
    }
}

impl ForOrder for Messaged {
    fn order_number(&self) -> &str {
        &self.order_number
    }
}

/// New results replace earlier ones for the same order in place; the rest follow.
pub fn merge<T: ForOrder>(earlier: &mut Vec<T>, new: Vec<T>) {
    for result in new {
        match earlier
            .iter_mut()
            .find(|e| e.order_number() == result.order_number())
        {
            Some(slot) => *slot = result,
            None => earlier.push(result),
        }
    }
}

/// Each production purchase and the orders its shipment carries that no shipment before it did.
fn produced<'a>(
    shipments: &'a [Planned],
    postage: &'a Postage,
) -> impl Iterator<Item = (&'a Purchase, &'a Planned, Vec<String>)> + 'a {
    let mut seen = HashSet::new();
    shipments.iter().filter_map(move |planned| {
        let purchase = postage.get(planned.reference())?.in_production()?;
        let orders = planned
            .orders
            .iter()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty() && seen.insert(n.clone()))
            .collect();
        Some((purchase, planned, orders))
    })
}

/// What is still to do, and what is done.
#[derive(Debug, Default, PartialEq)]
pub struct Pending {
    pub tracking: Vec<Tracking>,
    pub already_tracked: usize,
    pub messages: Vec<Message>,
}

impl Pending {
    pub fn of(
        orders: &[Order],
        shipments: &[Planned],
        postage: &Postage,
        tracked: &[Tracked],
        messaged: &[Messaged],
        seller_key: &str,
    ) -> Pending {
        let mut on_record: HashMap<String, String> = orders
            .iter()
            .map(|o| {
                (
                    o.number.trim().to_owned(),
                    o.tracking_number.trim().to_owned(),
                )
            })
            .collect();
        for t in tracked.iter().filter(|t| t.status == "applied") {
            on_record.insert(t.order_number.clone(), t.tracking_number.clone());
        }
        let mut pending = Pending::default();
        for (purchase, planned, numbers) in produced(shipments, postage) {
            let Some(code) = purchase.tracking_code.as_deref() else {
                continue;
            };
            for number in numbers {
                if on_record.get(&number).map(String::as_str) == Some(code) {
                    pending.already_tracked += 1;
                } else {
                    pending.tracking.push(Tracking {
                        order_number: number,
                        carrier: planned.shipment.carrier.clone(),
                        tracking_number: code.to_owned(),
                    });
                }
            }
        }
        let seller_key = seller_key.trim();
        if seller_key.is_empty() {
            return pending;
        }
        let sent: HashMap<&str, &str> = messaged
            .iter()
            .filter(|m| m.status == "sent")
            .map(|m| (m.order_number.as_str(), m.easypost_shipment_id.as_str()))
            .collect();
        for (purchase, _, numbers) in produced(shipments, postage) {
            let Some(id) = purchase.easypost_shipment_id.as_deref() else {
                continue;
            };
            for number in numbers {
                if sent.get(number.as_str()) != Some(&id) {
                    pending.messages.push(Message {
                        order_number: number,
                        seller_key: seller_key.to_owned(),
                        easypost_shipment_id: id.to_owned(),
                    });
                }
            }
        }
        pending
    }

    /// The orders with something still to send, each once.
    pub fn orders(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        self.tracking
            .iter()
            .map(|t| t.order_number.as_str())
            .chain(self.messages.iter().map(|m| m.order_number.as_str()))
            .filter(|n| seen.insert(*n))
            .collect()
    }
}

pub async fn apply_tracking(legacy: &Legacy, updates: &[Tracking]) -> Result<Vec<Tracked>, String> {
    #[derive(Serialize)]
    struct Request<'a> {
        updates: &'a [Tracking],
    }
    #[derive(Deserialize)]
    struct Answer {
        results: Vec<Tracked>,
    }
    let answer: Answer = legacy
        .send(
            "/api/shipping-export/tcgplayer-tracking",
            &Request { updates },
        )
        .await?;
    Ok(answer.results)
}

pub async fn send_messages(legacy: &Legacy, messages: &[Message]) -> Result<Vec<Messaged>, String> {
    #[derive(Serialize)]
    struct Request<'a> {
        messages: &'a [Message],
    }
    #[derive(Deserialize)]
    struct Answer {
        results: Vec<Messaged>,
    }
    let answer: Answer = legacy
        .send(
            "/api/shipping-export/tcgplayer-shipped-messages",
            &Request { messages },
        )
        .await?;
    Ok(answer.results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{
        shipping_configuration::{EasyPostMode, ShippingConfig},
        shipping_export::{
            orders::tests::order,
            postage::{Bought, Status},
            shipments::Batch,
        },
    };

    fn bought(reference: &str, code: &str, mode: EasyPostMode) -> (String, Bought) {
        (
            reference.into(),
            Bought {
                mode,
                result: Purchase {
                    reference: reference.into(),
                    order_numbers: vec![reference.into()],
                    status: Status::Purchased,
                    easypost_shipment_id: Some(format!("shp_{reference}")),
                    tracking_code: Some(code.into()),
                    selected_rate: None,
                    label_url: None,
                    label_pdf_url: None,
                    error: None,
                },
                purchased_at: None,
            },
        )
    }

    fn separately() -> ShippingConfig {
        ShippingConfig {
            combine_orders: false,
            ..ShippingConfig::default()
        }
    }

    /// `buildTrackingApplyItems skips orders that already carry the purchased tracking`.
    #[test]
    fn tracking_skips_orders_that_already_carry_it() {
        let mut orders: Vec<_> = ["A", "B", "C", "D", "E"].map(order).into();
        orders[1].tracking_number = " TRACK-B ".into();
        orders[4].tracking_number = "TRACK-OLD".into();
        let batch = Batch::plan(orders, &separately());
        let postage: Postage = [
            bought("A", "TRACK-A", EasyPostMode::Production),
            bought("B", "TRACK-B", EasyPostMode::Production),
            bought("C", "TRACK-C", EasyPostMode::Production),
            bought("D", "TRACK-D", EasyPostMode::Test),
            bought("E", "TRACK-E", EasyPostMode::Production),
        ]
        .into();
        let applied = Tracked {
            order_number: "C".into(),
            carrier: "USPS".into(),
            tracking_number: "TRACK-C".into(),
            status: "applied".into(),
            error: None,
        };
        let pending = Pending::of(
            &batch.orders,
            &batch.shipments,
            &postage,
            &[applied],
            &[],
            "",
        );
        let sent: Vec<_> = pending
            .tracking
            .iter()
            .map(|t| (t.order_number.as_str(), t.tracking_number.as_str()))
            .collect();
        assert_eq!(sent, [("A", "TRACK-A"), ("E", "TRACK-E")]);
        assert_eq!(pending.already_tracked, 2);
        assert!(pending.messages.is_empty(), "no seller, no messages");
    }

    /// `buildShippedMessageItems skips orders that were already messaged`.
    #[test]
    fn messages_skip_orders_told_about_the_same_label() {
        let batch = Batch::plan(["A", "B", "C"].map(order).into(), &separately());
        let postage: Postage = ["A", "B", "C"]
            .map(|r| bought(r, &format!("TRACK-{r}"), EasyPostMode::Production))
            .into();
        let told = |n: &str, id: &str| Messaged {
            order_number: n.into(),
            seller_key: "seller".into(),
            easypost_shipment_id: id.into(),
            tracking_url: None,
            status: "sent".into(),
            error: None,
        };
        let pending = Pending::of(
            &batch.orders,
            &batch.shipments,
            &postage,
            &[],
            &[told("A", "shp_A"), told("C", "shp_C_old")],
            " seller ",
        );
        let to: Vec<_> = pending
            .messages
            .iter()
            .map(|m| (m.order_number.as_str(), m.seller_key.as_str()))
            .collect();
        assert_eq!(to, [("B", "seller"), ("C", "seller")]);
        assert_eq!(pending.orders(), ["A", "B", "C"]);
    }

    #[test]
    fn a_new_result_replaces_the_orders_earlier_one_in_place() {
        let r = |n: &str, status: &str| Tracked {
            order_number: n.into(),
            carrier: String::new(),
            tracking_number: String::new(),
            status: status.into(),
            error: None,
        };
        let mut earlier = vec![r("A", "applied"), r("B", "failed")];
        merge(&mut earlier, vec![r("C", "applied"), r("B", "applied")]);
        let all: Vec<_> = earlier
            .iter()
            .map(|t| (t.order_number.as_str(), t.status.as_str()))
            .collect();
        assert_eq!(all, [("A", "applied"), ("B", "applied"), ("C", "applied")]);
    }
}
