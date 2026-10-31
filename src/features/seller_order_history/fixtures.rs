//! Recorded order management answers (`tests/fixtures/tcgplayer/seller_orders`), scrubbed of the
//! seller's and buyers' details, and the checks that run against them. The recording itself is an
//! ignored test that reads TCGplayer live: `cargo test record_seller_order_fixtures -- --ignored`.
use std::{collections::BTreeMap, path::PathBuf};

use serde_json::{Value, json};

use super::{
    api::SearchPage,
    observation::{self, Fields},
};

fn folder() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tcgplayer/seller_orders")
}

/// The fields of `from` named in `keys`, as they are.
fn kept(from: &Fields, keys: &[&str]) -> Fields {
    keys.iter()
        .filter_map(|k| from.get(*k).map(|v| ((*k).to_owned(), v.clone())))
        .collect()
}

/// Order numbers made up in the order they are first met, the same one each time for an order,
/// so a search result and its detail still match.
#[derive(Default)]
pub struct Scrubber {
    numbers: BTreeMap<String, String>,
}

impl Scrubber {
    fn number(&mut self, real: &Value) -> Value {
        let real = real.as_str().unwrap_or_default().to_owned();
        let next = self.numbers.len() + 1;
        Value::from(
            self.numbers
                .entry(real)
                .or_insert_with(|| format!("FIXTURE-{next:04}"))
                .clone(),
        )
    }

    /// A search result with only the fields the history reads, its buyer and number made up.
    pub fn summary(&mut self, summary: &Fields) -> Fields {
        let mut out = kept(
            summary,
            &[
                "orderDate",
                "orderChannel",
                "orderStatus",
                "shippingType",
                "productAmount",
                "shippingAmount",
                "totalAmount",
                "buyerPaid",
                "orderFulfillment",
            ],
        );
        if let Some(number) = summary.get("orderNumber") {
            out.insert("orderNumber".into(), self.number(number));
        }
        out.insert("buyerName".into(), "Buyer".into());
        out
    }

    /// An order's detail with only the fields the history reads; its buyer, seller and address
    /// made up, its tracking dropped.
    pub fn detail(&mut self, detail: &Fields) -> Fields {
        let mut out = kept(
            detail,
            &[
                "createdAt",
                "status",
                "orderChannel",
                "orderFulfillment",
                "pickupStatus",
                "shippingType",
                "estimatedDeliveryDate",
                "transaction",
                "refundStatus",
                "allowedActions",
            ],
        );
        if let Some(number) = detail.get("orderNumber") {
            out.insert("orderNumber".into(), self.number(number));
        }
        out.insert("sellerName".into(), "Seller".into());
        out.insert("buyerName".into(), "Buyer".into());
        out.insert(
            "shippingAddress".into(),
            json!({
                "recipientName": "Buyer",
                "addressOne": "1 Main St",
                "city": "Springfield",
                "territory": "IL",
                "country": "US",
                "postalCode": "62701",
            }),
        );
        let list = |key: &str| {
            detail
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let products: Vec<Value> = list("products")
            .iter()
            .filter_map(Value::as_object)
            .map(|p| {
                Value::Object(kept(
                    p,
                    &[
                        "name",
                        "unitPrice",
                        "extendedPrice",
                        "quantity",
                        "url",
                        "productId",
                        "skuId",
                    ],
                ))
            })
            .collect();
        out.insert("products".into(), Value::Array(products));
        let refunds: Vec<Value> = list("refunds")
            .iter()
            .filter_map(Value::as_object)
            .map(|r| {
                let mut kept = kept(
                    r,
                    &["createdAt", "type", "amount", "origin", "shippingAmount"],
                );
                if let Some(Value::Array(products)) = r.get("products") {
                    let products = products
                        .iter()
                        .filter_map(Value::as_object)
                        .map(|p| Value::Object(self::kept(p, &["amount", "productId", "skuId"])))
                        .collect();
                    kept.insert("products".into(), Value::Array(products));
                }
                Value::Object(kept)
            })
            .collect();
        out.insert("refunds".into(), Value::Array(refunds));
        out
    }
}

fn read(name: &str) -> Value {
    let text = std::fs::read_to_string(folder().join(name)).expect("the fixture is recorded");
    serde_json::from_str(&text).expect("the fixture is JSON")
}

/// Every recorded order: its search result and its detail.
fn recorded() -> Vec<(Fields, Fields)> {
    let page: SearchPage = serde_json::from_value(read("search.json")).expect("a search page");
    let mut summaries: Vec<Fields> = page.orders;
    if let Value::Array(more) = read("found.json") {
        summaries.extend(more.into_iter().filter_map(|v| v.as_object().cloned()));
    }
    summaries
        .into_iter()
        .map(|summary| {
            let number = summary["orderNumber"].as_str().unwrap().to_owned();
            let detail = read(&format!("orders/{number}.json"));
            (
                summary,
                detail.as_object().cloned().expect("a detail object"),
            )
        })
        .collect()
}

/// When the recorded orders were observed, which their fingerprints do not depend on.
const OBSERVED_AT: &str = "2026-10-30T00:00:00.000Z";

#[test]
fn recorded_orders_fingerprint_as_the_node_app_does() {
    let expected = read("expected.json");
    let orders = recorded();
    assert!(
        orders.len() >= 3,
        "a page and the refunded orders are recorded"
    );
    for (summary, detail) in orders {
        let number = summary["orderNumber"].as_str().unwrap();
        let o = observation::observe("SELLER", Some(&summary), &detail, OBSERVED_AT)
            .unwrap_or_else(|why| panic!("{number} observes: {why}"));
        let want = &expected[number];
        assert_eq!(
            Some(o.summary_fingerprint.as_deref().unwrap_or_default()),
            want["summaryFingerprint"].as_str(),
            "{number}'s search result"
        );
        assert_eq!(
            Some(o.fingerprint.as_str()),
            want["fingerprint"].as_str(),
            "{number}'s detail"
        );
        assert_eq!(
            Some(o.lifecycle),
            want["lifecycle"].as_str(),
            "{number}'s lifecycle"
        );
    }
}

/// Every text in `value`, keys included.
fn texts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| texts(v, out)),
        Value::Object(fields) => {
            for (k, v) in fields {
                out.push(k.clone());
                texts(v, out);
            }
        }
        _ => {}
    }
}

#[test]
fn the_scrubber_keeps_no_cookie_name_or_address() {
    let detail = json!({
        "orderNumber": "8520A14F-1A2B3C-4D5E6",
        "createdAt": "2026-09-01T10:00:00Z",
        "sellerName": "Real Store LLC",
        "buyerName": "Jane Q Buyer",
        "buyerEmail": "jane@example.com",
        "paymentType": "VISA",
        "cookie": "TCGAuthTicket_Production=secret",
        "shippingAddress": { "recipientName": "Jane Q Buyer", "addressOne": "742 Evergreen Terrace", "city": "Shelbyville", "territory": "OR", "country": "US", "postalCode": "97001" },
        "trackingNumbers": [{ "trackingNumber": "9400111899223" }],
        "transaction": { "productAmount": 1.0 },
        "products": [{ "name": "Card", "skuId": "1", "buyerNote": "Jane Q Buyer" }],
        "refunds": [{ "type": "Partial", "amount": 1.0, "note": "for Jane Q Buyer at 742 Evergreen Terrace" }],
    });
    let summary = json!({ "orderNumber": "8520A14F-1A2B3C-4D5E6", "buyerName": "Jane Q Buyer" });
    let mut scrubber = Scrubber::default();
    let out = json!([
        scrubber.summary(summary.as_object().unwrap()),
        scrubber.detail(detail.as_object().unwrap()),
    ]);
    let mut all = Vec::new();
    texts(&out, &mut all);
    for secret in [
        "paymentType",
        "8520A14F",
        "Jane",
        "Real Store",
        "742 Evergreen",
        "Shelbyville",
        "TCGAuthTicket",
        "9400111899223",
        "jane@example.com",
        "buyerEmail",
        "trackingNumbers",
        "note",
    ] {
        assert!(!all.iter().any(|t| t.contains(secret)), "{secret} was kept");
    }
    assert_eq!(out[0]["orderNumber"], out[1]["orderNumber"]);
}

#[test]
fn the_recordings_hold_nothing_the_scrubber_drops() {
    let mut all = Vec::new();
    for name in ["search.json", "found.json"] {
        texts(&read(name), &mut all);
    }
    for (_, detail) in recorded() {
        texts(&Value::Object(detail), &mut all);
    }
    let allowed_people = ["Buyer", "Seller"];
    for (summary, detail) in recorded() {
        for fields in [summary, detail] {
            for key in ["buyerName", "sellerName"] {
                if let Some(name) = fields.get(key).and_then(Value::as_str) {
                    assert!(allowed_people.contains(&name), "a real {key} was kept");
                }
            }
            if let Some(number) = fields.get("orderNumber").and_then(Value::as_str) {
                assert!(
                    number.starts_with("FIXTURE-"),
                    "a real order number was kept"
                );
            }
        }
    }
    assert!(
        !all.iter()
            .any(|t| t.contains("TCGAuthTicket") || t == "trackingNumbers")
    );
}

/// Reads TCGplayer live (decisions 19 and 23 in the port plan): the oldest page of six orders
/// from the last three months, and the newest partly refunded and canceled ones Node recorded,
/// with each one's detail; scrubbed, then written over the fixtures.
#[tokio::test]
#[ignore = "reads TCGplayer live with the dev database's cookie"]
async fn record_seller_order_fixtures() {
    use crate::{database::Database, features::shipping_configuration, tcgplayer::TcgPlayer};

    crate::config::load_env();
    let db = Database::connect_lazy(&crate::config::database_url());
    let seller = shipping_configuration::default_seller_key(&db)
        .await
        .unwrap();
    let seller = seller.trim();
    assert!(!seller.is_empty(), "a default seller key is set");
    let tcg = TcgPlayer::new(db.clone());
    let page = super::api::search(&tcg, seller, 0, 6)
        .await
        .expect("the search answers");
    let refunded: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT ON (lifecycle) order_number FROM seller_orders
         WHERE seller_key = $1 AND order_time > now() - interval '80 days'
           AND refund_status IN ('Partial Refund', 'Full Refund')
         ORDER BY lifecycle, order_time DESC",
    )
    .bind(seller)
    .fetch_all(&db.0)
    .await
    .unwrap();
    let mut found = Vec::new();
    for (number,) in &refunded {
        if let Some(summary) = super::api::find(&tcg, seller, number)
            .await
            .expect("the search answers")
        {
            found.push(summary);
        }
    }
    let mut scrubber = Scrubber::default();
    let mut details = Vec::new();
    for summary in page.orders.iter().chain(&found) {
        let number = summary["orderNumber"].as_str().unwrap();
        let detail = super::api::order(&tcg, number)
            .await
            .expect("the detail answers");
        details.push(detail);
    }
    let orders: Vec<Value> = page
        .orders
        .iter()
        .map(|s| Value::Object(scrubber.summary(s)))
        .collect();
    let found: Vec<Value> = found
        .iter()
        .map(|s| Value::Object(scrubber.summary(s)))
        .collect();
    let dir = folder();
    std::fs::create_dir_all(dir.join("orders")).unwrap();
    let write = |name: &str, value: &Value| {
        std::fs::write(
            dir.join(name),
            serde_json::to_string_pretty(value).unwrap() + "\n",
        )
        .unwrap();
    };
    write(
        "search.json",
        &json!({ "totalOrders": page.total_orders, "orders": orders }),
    );
    write("found.json", &Value::Array(found));
    for detail in &details {
        let scrubbed = scrubber.detail(detail);
        let number = scrubbed["orderNumber"].as_str().unwrap().to_owned();
        write(&format!("orders/{number}.json"), &Value::Object(scrubbed));
    }
}

/// The recorded answers as an order management API: the search page, the orders found by number,
/// and each detail, the detail of FIXTURE-0005 failing the first time it is read.
pub struct RecordedOrders {
    page: Vec<Fields>,
    found: Vec<Fields>,
    failed_once: std::sync::atomic::AtomicBool,
}

impl RecordedOrders {
    pub fn new() -> Self {
        let objects = |value: Value| -> Vec<Fields> {
            value
                .as_array()
                .expect("a list of orders")
                .iter()
                .filter_map(|v| v.as_object().cloned())
                .collect()
        };
        RecordedOrders {
            page: objects(read("search.json")["orders"].take()),
            found: objects(read("found.json")),
            failed_once: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The orders found by number, which a sync is asked about first.
    pub fn found_numbers(&self) -> Vec<String> {
        self.found
            .iter()
            .filter_map(|s| s["orderNumber"].as_str().map(str::to_owned))
            .collect()
    }
}

impl super::sync::Orders for RecordedOrders {
    async fn search(
        &self,
        _: &str,
        from: u32,
        size: u32,
    ) -> Result<SearchPage, crate::tcgplayer::Failure> {
        Ok(SearchPage {
            total_orders: self.page.len() as u32,
            orders: self
                .page
                .iter()
                .skip(from as usize)
                .take(size as usize)
                .cloned()
                .collect(),
        })
    }

    async fn find(
        &self,
        _: &str,
        number: &str,
    ) -> Result<Option<Fields>, crate::tcgplayer::Failure> {
        Ok(self
            .page
            .iter()
            .chain(&self.found)
            .find(|s| s["orderNumber"] == number)
            .cloned())
    }

    async fn order(&self, number: &str) -> Result<Fields, crate::tcgplayer::Failure> {
        use std::sync::atomic::Ordering;
        if number == "FIXTURE-0005" && !self.failed_once.swap(true, Ordering::SeqCst) {
            return Err(crate::tcgplayer::Failure::Status(500));
        }
        Ok(read(&format!("orders/{number}.json"))
            .as_object()
            .cloned()
            .expect("a detail object"))
    }
}
