//! Marking orders shipped: their tracking applied on TCGplayer through its order management API
//! (`/api/shipping-export/tcgplayer-tracking`), then their buyers told through its messages API
//! with each shipment's public tracking page from EasyPost (`tcgplayer-shipped-messages`). Only production
//! postage is real, so only it is sent. What is still to send is worked out from what was sent,
//! so sending again after a lost answer or a reload reaches only what has not gone.
use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    easypost::{self, Api},
    orders::Order,
    postage::{Postage, Purchase},
    shipments::Planned,
};
use crate::{
    features::{
        http_configuration::config::Domain, seller_order_history::api::component,
        shipping_configuration::EasyPostMode,
    },
    tcgplayer::{Call, TcgPlayer},
};

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

/// Where tracking is applied: TCGplayer's order management API.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait TrackingApi {
    /// Posts `body` to `path`, answering why it failed.
    async fn post(&self, path: &str, body: &Value) -> Result<(), String>;
}

/// What axios asks for by default, as the Node app asked.
const AXIOS_ACCEPT: &str = "application/json, text/plain, */*";

/// The API, through the app's TCGplayer client and its rate limits; the answer is not read.
pub struct TcgPlayerTracking(pub TcgPlayer);

impl TrackingApi for TcgPlayerTracking {
    async fn post(&self, path: &str, body: &Value) -> Result<(), String> {
        self.0
            .post_for_bytes(
                Domain::OrderManagementApi,
                path,
                body,
                AXIOS_ACCEPT,
                Call::default(),
            )
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    }
}

/// Each order's tracking applied on TCGplayer, the first update of an order only
/// (`applyTrackingToSellerOrders`); an update without an order number, carrier or tracking number
/// is refused as the Node route refuses it.
pub async fn apply_tracking(
    api: &impl TrackingApi,
    updates: &[Tracking],
) -> Result<Vec<Tracked>, String> {
    if updates.is_empty() {
        return Err("updates must be a non-empty array.".to_owned());
    }
    let blank = |t: &Tracking| {
        [&t.order_number, &t.carrier, &t.tracking_number]
            .iter()
            .any(|s| s.trim().is_empty())
    };
    if updates.iter().any(blank) {
        return Err(
            "Each tracking update must include an orderNumber, carrier, and trackingNumber."
                .to_owned(),
        );
    }
    let mut seen = HashSet::new();
    let firsts = updates
        .iter()
        .filter(|t| seen.insert(t.order_number.trim().to_owned()));
    Ok(join_all(firsts.map(|t| async move {
        let path = format!(
            "/orders/{}/tracking?api-version=2.0",
            component(&t.order_number)
        );
        let body = json!({ "carrier": t.carrier, "trackingNumber": t.tracking_number });
        let failed = api.post(&path, &body).await.err();
        Tracked {
            order_number: t.order_number.clone(),
            carrier: t.carrier.clone(),
            tracking_number: t.tracking_number.clone(),
            status: if failed.is_none() {
                "applied"
            } else {
                "failed"
            }
            .to_owned(),
            error: failed.map(|e| format!("Error: {e}")),
        }
    }))
    .await)
}

/// Where buyers are written to: TCGplayer's messages API.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait MessagesApi {
    /// Starts a message thread with `body`, answering why it failed.
    async fn start_thread(&self, body: &Value) -> Result<(), String>;
}

/// The API, through the app's TCGplayer client and its rate limits; the answer is not read.
pub struct TcgPlayerMessages(pub TcgPlayer);

impl MessagesApi for TcgPlayerMessages {
    async fn start_thread(&self, body: &Value) -> Result<(), String> {
        self.0
            .post_for_bytes(
                Domain::MessagesApi,
                "/messages/threads?api-version=1.0",
                body,
                AXIOS_ACCEPT,
                Call::default(),
            )
            .await
            .map(drop)
            .map_err(|e| e.to_string())
    }
}

const STORE_NAME: &str = "Pok\u{e9}Bash TCG";
const SUPPORT_SIGNATURE: &str = "Pok\u{e9}Bash TCG Support Team";

/// The message a buyer gets when their order ships (`buildShippedMessageBody`).
fn shipped_message(tracking_url: &str) -> String {
    let url = tracking_url.replace('&', "&amp;").replace('"', "&quot;");
    [
        "<b>TLDR: Your order has shipped! Use the tracking link below for updates, and please reply if you have any questions or issues. Your satisfaction is guaranteed.</b>",
        "",
        "Greetings,",
        "",
        "Great news \u{2014} your order is on its way! We\u{2019}re excited to get your cards into your hands.",
        "",
        "You can track your shipment here:",
        "",
        &format!("<a href=\"{url}\" target=\"_blank\">{STORE_NAME} Tracking</a>"),
        "",
        "Please keep in mind that it can take 24\u{2013}48 hours for the first scan to appear, so a short delay in updates is completely normal.",
        "",
        "If your order has not arrived within a week of shipping, please reply to this message and we\u{2019}ll gladly look into it for you.",
        "",
        "We\u{2019}re committed to your satisfaction with a 100% satisfaction guarantee. If anything about your order is not as expected, including card condition or delivery concerns, please contact us right away and we\u{2019}ll work to make it right.",
        "",
        "Your feedback means a lot to us. Once your order arrives, we\u{2019}d greatly appreciate it if you took a moment to leave a review of your purchase.",
        "",
        &format!("Thank you again for choosing {STORE_NAME}. We hope you love your new cards!"),
        "",
        "Warm regards,",
        SUPPORT_SIGNATURE,
    ]
    .join("\n")
}

/// Each order's buyer told their order shipped, with its production shipment's public tracking
/// page, the first message of an order only, each shipment's page read once
/// (`sendShippedMessagesToSellerOrders`); a message without an order number, seller or shipment
/// is refused as the Node route refuses it.
pub async fn send_messages(
    api: &impl MessagesApi,
    easypost: &impl Api,
    messages: &[Message],
) -> Result<Vec<Messaged>, String> {
    if messages.is_empty() {
        return Err("messages must be a non-empty array.".to_owned());
    }
    let blank = |m: &Message| {
        [&m.order_number, &m.seller_key, &m.easypost_shipment_id]
            .iter()
            .any(|s| s.trim().is_empty())
    };
    if messages.iter().any(blank) {
        return Err(
            "Each shipped message must include an orderNumber, sellerKey, and easypostShipmentId."
                .to_owned(),
        );
    }
    let mut seen = HashSet::new();
    let firsts: Vec<Message> = messages
        .iter()
        .map(|m| Message {
            order_number: m.order_number.trim().to_owned(),
            seller_key: m.seller_key.trim().to_owned(),
            easypost_shipment_id: m.easypost_shipment_id.trim().to_owned(),
        })
        .filter(|m| seen.insert(m.order_number.clone()))
        .collect();
    let mut shipments: Vec<String> = Vec::new();
    for m in &firsts {
        if !shipments.contains(&m.easypost_shipment_id) {
            shipments.push(m.easypost_shipment_id.clone());
        }
    }
    let urls: HashMap<String, Result<String, String>> =
        join_all(shipments.into_iter().map(|id| async move {
            let url = easypost::tracking_url(easypost, EasyPostMode::Production, &id).await;
            (id, url)
        }))
        .await
        .into_iter()
        .collect();
    Ok(join_all(firsts.into_iter().map(|m| {
        let url = urls[&m.easypost_shipment_id].clone();
        async move {
            let sent = match url {
                Ok(url) => {
                    let body = json!({
                        "sellerKey": m.seller_key,
                        "subjectId": "2",
                        "messageBody": shipped_message(&url),
                        "associationType": "SellerOrder",
                        "associationValue": m.order_number,
                    });
                    api.start_thread(&body).await.map(|()| url)
                }
                Err(e) => Err(e),
            };
            Messaged {
                order_number: m.order_number,
                seller_key: m.seller_key,
                easypost_shipment_id: m.easypost_shipment_id,
                status: if sent.is_ok() { "sent" } else { "failed" }.to_owned(),
                error: sent.as_ref().err().map(|e| format!("Error: {e}")),
                tracking_url: sent.ok(),
            }
        }
    }))
    .await)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// The tracking post as a case of `.port-logs/tracking-cases.json` scripts it, noting each.
    struct Scripted {
        fail: Value,
        posted: Mutex<Vec<Value>>,
    }

    impl TrackingApi for Scripted {
        async fn post(&self, path: &str, body: &Value) -> Result<(), String> {
            self.posted
                .lock()
                .unwrap()
                .push(json!({ "path": path, "body": body }));
            let failing = self.fail.as_object().unwrap().iter().find(|(number, _)| {
                path == format!("/orders/{}/tracking?api-version=2.0", component(number))
            });
            match failing {
                Some((_, why)) => Err(why.as_str().unwrap().to_owned()),
                None => Ok(()),
            }
        }
    }

    impl MessagesApi for Scripted {
        async fn start_thread(&self, body: &Value) -> Result<(), String> {
            self.posted
                .lock()
                .unwrap()
                .push(json!({ "path": "/messages/threads?api-version=1.0", "body": body }));
            match &self.fail[body["associationValue"].as_str().unwrap()] {
                Value::String(why) => Err(why.clone()),
                _ => Ok(()),
            }
        }
    }

    /// EasyPost as `.port-logs/messages-cases.json` scripts its shipments, noting each request.
    async fn easypost_stand_in(
        shipments: Value,
    ) -> (
        crate::features::shipping_export::easypost::EasyPost,
        std::sync::Arc<Mutex<Vec<Value>>>,
    ) {
        use corten::axum::{
            Router,
            http::{HeaderMap, Method, StatusCode, Uri},
        };
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
            let (kept, shipments) = (kept.clone(), shipments.clone());
            async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                kept.lock()
                    .unwrap()
                    .push(json!({ "method": method.as_str(), "path": uri.path(), "auth": auth }));
                let id = uri.path().rsplit('/').next().unwrap_or("");
                let s = &shipments[id];
                let status =
                    StatusCode::from_u16(s["status"].as_u64().unwrap_or(404) as u16).unwrap();
                (
                    status,
                    [("content-type", "application/json")],
                    s["body"].to_string(),
                )
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { corten::axum::serve(listener, app).await });
        let easypost = crate::features::shipping_export::easypost::EasyPost::stand_in(
            &origin,
            "EZTK_standin_production",
        );
        (easypost, asked)
    }

    /// Node's `createShippingTcgplayerShippedMessagesAction` over the cases in
    /// `.port-logs/messages.node.json`, Node's EasyPost client against the same stand-in: results,
    /// refusals, every EasyPost request and every message thread started.
    #[tokio::test]
    #[ignore = "reads Node's answers in .port-logs"]
    async fn buyers_are_told_as_node_tells_them() {
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let script: Value = serde_json::from_str(&read_log("messages-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("messages.node.json")).unwrap();
        let sorted = |mut list: Vec<Value>| {
            list.sort_by_key(|v| v.to_string());
            list
        };
        for (case, theirs) in script["cases"].as_array().unwrap().iter().zip(node) {
            let name = theirs["name"].as_str().unwrap();
            let messages: Vec<Message> = serde_json::from_value(case["messages"].clone()).unwrap();
            let api = Scripted {
                fail: case["threadFails"].clone(),
                posted: Mutex::new(Vec::new()),
            };
            let (easypost, asked) = easypost_stand_in(script["shipments"].clone()).await;
            let ours = send_messages(&api, &easypost, &messages).await;
            let expected = match theirs["status"].as_u64().unwrap() {
                200 => Ok(serde_json::from_value::<Vec<Messaged>>(
                    theirs["body"]["results"].clone(),
                )
                .unwrap()),
                _ => Err(theirs["body"]["error"].as_str().unwrap().to_owned()),
            };
            assert_eq!(ours, expected, "{name}");
            let asked = asked.lock().unwrap().clone();
            assert_eq!(
                sorted(asked),
                sorted(theirs["asked"].as_array().unwrap().clone()),
                "{name}: EasyPost"
            );
            assert_eq!(
                sorted(api.posted.into_inner().unwrap()),
                sorted(theirs["threads"].as_array().unwrap().clone()),
                "{name}: threads"
            );
        }
    }

    /// Node's `createShippingTcgplayerTrackingAction` over the cases in
    /// `.port-logs/tracking.node.json`, against a scripted tracking post: results, refusals and
    /// every post made.
    #[tokio::test]
    #[ignore = "reads Node's answers in .port-logs"]
    async fn tracking_is_applied_as_node_applies_it() {
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("tracking-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("tracking.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        for (case, theirs) in cases.into_iter().zip(node) {
            let name = theirs["name"].as_str().unwrap();
            let updates: Vec<Tracking> = serde_json::from_value(case["updates"].clone()).unwrap();
            let api = Scripted {
                fail: case["fail"].clone(),
                posted: Mutex::new(Vec::new()),
            };
            let ours = apply_tracking(&api, &updates).await;
            let expected = match theirs["status"].as_u64().unwrap() {
                200 => Ok(serde_json::from_value::<Vec<Tracked>>(
                    theirs["body"]["results"].clone(),
                )
                .unwrap()),
                _ => Err(theirs["body"]["error"].as_str().unwrap().to_owned()),
            };
            assert_eq!(ours, expected, "{name}");
            let by_path = |p: &Value| p["path"].as_str().unwrap().to_owned();
            let mut posted = api.posted.into_inner().unwrap();
            posted.sort_by_key(by_path);
            let mut node_posted = theirs["posted"].as_array().unwrap().clone();
            node_posted.sort_by_key(by_path);
            assert_eq!(posted, node_posted, "{name}: posted");
        }
    }
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
