//! An order as TCGplayer's order management API describes it, made into the evidence the order
//! history records: ported from `domain/sellerOrderObservation.ts`. Its fingerprints are the Node
//! app's byte for byte, since both apps compare them against the rows the other wrote.
use chrono::{DateTime, SecondsFormat};
use serde_json::{Map, Value};

use crate::features::{
    inventory_economics::ledger::fingerprint::{js_float, sha256_hex, stable_json},
    inventory_strategy::collate,
};

/// An object's fields as the API sent them. A field it left out is JavaScript's `undefined`,
/// which the Node app's `stableJson` writes as the bare word.
pub type Fields = Map<String, Value>;

/// Where an order is, from its provider status.
pub fn lifecycle(status: &str) -> &'static str {
    let words = status.split_whitespace().collect::<Vec<_>>().join(" ");
    match words.to_lowercase().as_str() {
        "processing" => "processing",
        "ready to ship" | "readytoship" => "ready_to_ship",
        "shipped - in transit" => "shipped_in_transit",
        "shipped - delivered" => "shipped_delivered",
        "completed - paid" => "completed_paid",
        "canceled" | "cancelled" => "canceled",
        _ => "unknown",
    }
}

/// `Math.round((value + Number.EPSILON) * 100) / 100`.
fn round_money(value: f64) -> f64 {
    ((value + f64::EPSILON) * 100.0 + 0.5).floor() / 100.0
}

/// A time with its UTC offset, as `Date.toISOString` writes it; one without an offset is refused.
pub fn offset_timestamp(value: &str, label: &str) -> Result<String, String> {
    let has_offset = value.ends_with(['Z', 'z']) || {
        let bytes = value.as_bytes();
        bytes.len() >= 6 && {
            let tail = &bytes[bytes.len() - 6..];
            matches!(tail[0], b'+' | b'-')
                && tail[1].is_ascii_digit()
                && tail[2].is_ascii_digit()
                && tail[3] == b':'
                && tail[4].is_ascii_digit()
                && tail[5].is_ascii_digit()
        }
    };
    let parsed = DateTime::parse_from_rfc3339(value)
        .ok()
        .filter(|_| has_offset);
    parsed
        .map(|at| at.to_utc().to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| format!("{label} must include a UTC offset."))
}

/// One SKU's line of an order.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub name: String,
    pub unit_price: f64,
    pub extended_price: f64,
    pub quantity: f64,
    pub product_id: String,
    pub sku_id: String,
}

impl Line {
    fn json(&self) -> Value {
        serde_json::json!({
            "name": self.name,
            "unitPrice": self.unit_price,
            "extendedPrice": self.extended_price,
            "quantity": self.quantity,
            "productId": self.product_id,
            "skuId": self.sku_id,
        })
    }
}

/// An order's lines, one per SKU: quantities and proceeds added up, in SKU order.
pub fn aggregate_lines(lines: &[Line]) -> Result<Vec<Line>, String> {
    let mut by_sku: Vec<Line> = Vec::new();
    for line in lines {
        let sku_id = line.sku_id.trim();
        if sku_id.is_empty() {
            return Err("Seller order line is missing skuId.".into());
        }
        if line.quantity.fract() != 0.0 || line.quantity <= 0.0 {
            return Err(format!("Seller order {sku_id} has an invalid quantity."));
        }
        let priced = |p: f64| p.is_finite() && p >= 0.0;
        if !priced(line.unit_price) || !priced(line.extended_price) {
            return Err(format!("Seller order {sku_id} has an invalid price."));
        }
        match by_sku.iter_mut().find(|l| l.sku_id == sku_id) {
            Some(previous) => {
                if !previous.product_id.is_empty()
                    && !line.product_id.is_empty()
                    && previous.product_id != line.product_id
                {
                    return Err(format!(
                        "Seller order SKU {sku_id} has conflicting product IDs."
                    ));
                }
                // `[previous.name, line.name].filter(Boolean).sort()[0] ?? ""`.
                let name = [&previous.name, &line.name]
                    .into_iter()
                    .filter(|n| !n.is_empty())
                    .min_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()))
                    .cloned()
                    .unwrap_or_default();
                let extended = previous.extended_price + line.extended_price;
                let quantity = previous.quantity + line.quantity;
                previous.unit_price = round_money(extended / quantity);
                previous.extended_price = round_money(extended);
                previous.quantity = quantity;
                previous.name = name;
                if previous.product_id.is_empty() {
                    previous.product_id.clone_from(&line.product_id);
                }
            }
            None => by_sku.push(Line {
                sku_id: sku_id.to_owned(),
                ..line.clone()
            }),
        }
    }
    by_sku.sort_by(|a, b| collate::compare(&a.sku_id, &b.sku_id));
    Ok(by_sku)
}

/// `stableJson` of a value the API sent, where a field it left out is `undefined`.
fn stable(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), stable_json)
}

/// `stableJson` of an object whose fields may be `undefined`: keys sorted as `Array.sort` does.
fn stable_object(mut fields: Vec<(&str, String)>) -> String {
    fields.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let written: Vec<String> = fields
        .into_iter()
        .map(|(key, value)| format!("{}:{value}", Value::from(key)))
        .collect();
    format!("{{{}}}", written.join(","))
}

/// Sorted as `(a, b) => stableJson(a).localeCompare(stableJson(b))`.
fn sort_by_json(values: &mut [Value]) {
    values.sort_by(|a, b| collate::compare(&stable_json(a), &stable_json(b)));
}

/// The refunds with only what the history keeps of them, each in a stable order.
fn refunds(refunds: &[Value]) -> Result<Vec<Value>, String> {
    let mut kept = Vec::with_capacity(refunds.len());
    for refund in refunds {
        let empty = Map::new();
        let refund = refund.as_object().unwrap_or(&empty);
        let mut out = Map::new();
        if let Some(Value::String(at)) = refund.get("createdAt") {
            out.insert(
                "createdAt".into(),
                offset_timestamp(at, "Seller order refund createdAt")?.into(),
            );
        }
        for key in ["type", "amount", "origin", "shippingAmount"] {
            let kept = match refund.get(key) {
                Some(Value::String(_)) => key == "type" || key == "origin",
                Some(Value::Number(_)) => key == "amount" || key == "shippingAmount",
                _ => false,
            };
            if kept {
                out.insert(key.into(), refund[key].clone());
            }
        }
        if let Some(Value::Array(products)) = refund.get("products") {
            let mut products: Vec<Value> = products
                .iter()
                .map(|product| {
                    let mut kept = Map::new();
                    if let Some(product) = product.as_object() {
                        if let Some(v @ Value::Number(_)) = product.get("amount") {
                            kept.insert("amount".into(), v.clone());
                        }
                        for key in ["productId", "skuId"] {
                            if let Some(v @ Value::String(_)) = product.get(key) {
                                kept.insert(key.into(), v.clone());
                            }
                        }
                    }
                    Value::Object(kept)
                })
                .collect();
            sort_by_json(&mut products);
            out.insert("products".into(), Value::Array(products));
        }
        kept.push(Value::Object(out));
    }
    sort_by_json(&mut kept);
    Ok(kept)
}

/// The fingerprint of a search result, which says whether its order's detail must be read again.
pub fn summary_fingerprint(summary: &Fields) -> Result<String, String> {
    let number = summary
        .get("orderNumber")
        .and_then(Value::as_str)
        .unwrap_or("");
    let date = summary
        .get("orderDate")
        .and_then(Value::as_str)
        .unwrap_or("");
    let date = offset_timestamp(date, &format!("Order {number} summary orderDate"))?;
    let mut fields = vec![("orderDate", stable_json(&Value::from(date)))];
    for key in [
        "orderNumber",
        "orderChannel",
        "orderStatus",
        "shippingType",
        "productAmount",
        "shippingAmount",
        "totalAmount",
        "buyerPaid",
        "orderFulfillment",
    ] {
        fields.push((key, stable(summary.get(key))));
    }
    Ok(sha256_hex(&stable_object(fields)))
}

/// Whether an order's detail must be read: a new order or a changed search result. Its lines
/// never change, and its status (which a refund changes too) is in the search result.
pub fn needs_detail(stored: Option<Option<&str>>, summary_fingerprint: &str) -> bool {
    stored.flatten() != Some(summary_fingerprint)
}

/// What the history records of an order read from the API.
#[derive(Clone, Debug, PartialEq)]
pub struct Observation {
    pub seller_key: String,
    pub order_number: String,
    pub order_time: String,
    pub summary_order_time: Option<String>,
    pub provider_status: String,
    pub lifecycle: &'static str,
    pub refund_status: Option<Value>,
    pub order_channel: Option<Value>,
    pub order_fulfillment: Option<Value>,
    pub gross_item_proceeds: f64,
    /// The transaction when every field of it is there, or why it is not recorded.
    pub transaction: Result<Value, &'static str>,
    pub lines: Vec<Line>,
    pub refunds: Vec<Value>,
    pub observed_at: String,
    pub fingerprint: String,
    pub summary_fingerprint: Option<String>,
}

fn number(fields: &Fields, key: &str) -> Option<f64> {
    fields.get(key).and_then(Value::as_f64)
}

fn text(fields: &Fields, key: &str) -> String {
    fields
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// The transaction, when it has every field the history records.
fn transaction(fields: &Fields) -> Option<Value> {
    let amounts = [
        "shippingAmount",
        "grossAmount",
        "feeAmount",
        "netAmount",
        "directFeeAmount",
    ];
    if amounts.iter().any(|key| number(fields, key).is_none()) {
        return None;
    }
    let taxes = fields.get("taxes")?.as_array()?;
    let taxes: Option<Vec<Value>> = taxes
        .iter()
        .map(|tax| {
            let tax = tax.as_object()?;
            let code = tax.get("code")?.as_str()?;
            let amount = tax.get("amount")?.as_f64()?;
            Some(serde_json::json!({ "code": code, "amount": amount }))
        })
        .collect();
    let mut kept = Map::new();
    kept.insert("productAmount".into(), fields["productAmount"].clone());
    for key in amounts {
        kept.insert(key.into(), fields[key].clone());
    }
    kept.insert("taxes".into(), Value::Array(taxes?));
    Some(Value::Object(kept))
}

fn lines(detail: &Fields) -> Result<Vec<Line>, String> {
    let products = detail
        .get("products")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    products
        .iter()
        .map(|product| {
            let product = product
                .as_object()
                .ok_or("Seller order line is not an object.")?;
            let price = |key| number(product, key).unwrap_or(f64::NAN);
            Ok(Line {
                name: text(product, "name"),
                unit_price: price("unitPrice"),
                extended_price: price("extendedPrice"),
                quantity: price("quantity"),
                product_id: text(product, "productId"),
                sku_id: text(product, "skuId"),
            })
        })
        .collect()
}

/// The fingerprint of what an order is: a new one is a new revision.
fn fingerprint(o: &Observation) -> Result<String, String> {
    let lines: Vec<Value> = aggregate_lines(&o.lines)?.iter().map(Line::json).collect();
    let (transaction, reason) = match &o.transaction {
        Ok(t) => (Some(t.clone()), None),
        Err(reason) => (None, Some(Value::from(*reason))),
    };
    Ok(sha256_hex(&stable_object(vec![
        (
            "orderNumber",
            stable_json(&Value::from(o.order_number.as_str())),
        ),
        (
            "orderTime",
            stable_json(&Value::from(o.order_time.as_str())),
        ),
        (
            "providerStatus",
            stable_json(&Value::from(o.provider_status.as_str())),
        ),
        ("lifecycle", stable_json(&Value::from(o.lifecycle))),
        ("refundStatus", stable(o.refund_status.as_ref())),
        ("orderChannel", stable(o.order_channel.as_ref())),
        ("orderFulfillment", stable(o.order_fulfillment.as_ref())),
        ("grossItemProceeds", js_float(o.gross_item_proceeds)),
        ("transaction", stable(transaction.as_ref())),
        ("transactionCoverageReason", stable(reason.as_ref())),
        ("lines", stable_json(&Value::Array(lines))),
        ("refunds", stable_json(&Value::Array(o.refunds.clone()))),
    ])))
}

/// An order's detail, with its search result when it came from one, as the history records it.
pub fn observe(
    seller_key: &str,
    summary: Option<&Fields>,
    detail: &Fields,
    observed_at: &str,
) -> Result<Observation, String> {
    let seller_key = seller_key.trim();
    if seller_key.is_empty() {
        return Err("Seller key is required.".into());
    }
    let order_number = text(detail, "orderNumber");
    if order_number.trim().is_empty() {
        return Err("Order number is required.".into());
    }
    let order_time = offset_timestamp(
        &text(detail, "createdAt"),
        &format!("Order {order_number} createdAt"),
    )?;
    let empty = Map::new();
    let raw = detail
        .get("transaction")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let gross = number(raw, "productAmount")
        .filter(|v| *v >= 0.0)
        .ok_or_else(|| format!("Order {order_number} has invalid gross item proceeds."))?;
    let summary_date = summary
        .and_then(|s| s.get("orderDate"))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty());
    let summary_order_time = summary_date
        .map(|d| offset_timestamp(d, &format!("Order {order_number} summary orderDate")))
        .transpose()?;
    let refund_list = detail
        .get("refunds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let status = text(detail, "status");
    let mut observation = Observation {
        seller_key: seller_key.to_owned(),
        order_number: order_number.trim().to_owned(),
        order_time,
        summary_order_time,
        lifecycle: lifecycle(&status),
        provider_status: status,
        refund_status: detail.get("refundStatus").cloned(),
        order_channel: detail.get("orderChannel").cloned(),
        order_fulfillment: detail.get("orderFulfillment").cloned(),
        gross_item_proceeds: gross,
        transaction: transaction(raw).ok_or("provider_transaction_fields_unavailable"),
        lines: lines(detail)?,
        refunds: refunds(&refund_list)?,
        observed_at: observed_at.to_owned(),
        fingerprint: String::new(),
        summary_fingerprint: None,
    };
    observation.fingerprint = fingerprint(&observation)?;
    observation.summary_fingerprint = match (summary, summary_date) {
        (Some(summary), Some(_)) => Some(summary_fingerprint(summary)?),
        _ => None,
    };
    Ok(observation)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fields(value: Value) -> Fields {
        match value {
            Value::Object(fields) => fields,
            _ => unreachable!("an object"),
        }
    }

    fn detail() -> Value {
        json!({
            "createdAt": "2026-08-10T14:00:00.440Z", "status": "Ready to Ship",
            "orderChannel": "TcgMarketplace", "orderFulfillment": "Normal",
            "orderNumber": "SYNTHETIC-1001", "sellerName": "", "buyerName": "", "shippingType": "Standard",
            "transaction": { "productAmount": 12.5, "shippingAmount": 0, "grossAmount": 12.5,
                "feeAmount": 0, "netAmount": 12.5, "directFeeAmount": 0, "taxes": [] },
            "products": [
                { "name": "Card", "unitPrice": 6.25, "extendedPrice": 6.25, "quantity": 1, "url": "", "productId": "10", "skuId": "100" },
                { "name": "Card", "unitPrice": 6.25, "extendedPrice": 6.25, "quantity": 1, "url": "", "productId": "10", "skuId": "100" }
            ],
            "refunds": [{ "createdAt": "2026-08-11T00:00:00Z", "type": "Partial", "amount": 1.25,
                "origin": "BuyerInitiated", "reason": "ProviderEnum", "reasonText": "private note",
                "products": [{ "amount": 1.25, "productId": "10", "skuId": "100", "private": "drop" }] }],
            "refundStatus": "Partial Refund", "trackingNumbers": [], "allowedActions": []
        })
    }

    fn summary() -> Fields {
        fields(json!({
            "orderNumber": "SYNTHETIC-1001", "orderDate": "2026-08-10T14:00:00.000Z",
            "orderChannel": "TcgMarketplace", "orderStatus": "Ready to Ship", "buyerName": "private",
            "shippingType": "Standard", "productAmount": 12.5, "shippingAmount": 0,
            "totalAmount": 12.5, "buyerPaid": true, "orderFulfillment": "Normal"
        }))
    }

    const AT: &str = "2026-09-07T00:00:00Z";

    // The expected fingerprints are the Node app's (`observeSellerOrder`,
    // `fingerprintSellerOrderSummary`) for the same input.
    #[test]
    fn fingerprints_match_the_node_app() {
        let first = observe(" seller-a ", Some(&summary()), &fields(detail()), AT).unwrap();
        assert_eq!(first.seller_key, "seller-a");
        assert_eq!(
            first.summary_order_time.as_deref(),
            Some("2026-08-10T14:00:00.000Z")
        );
        assert_eq!(
            first.fingerprint,
            "8e48aab79956998eeba6dc946601f59c2c5ebc99a63ec1b4473832e1b323765a"
        );
        assert_eq!(
            first.summary_fingerprint.as_deref(),
            Some("b5d8f7599322968213d01dc113a2638e50a846b338c0a08e005339c4cb741273")
        );
        assert_eq!(
            first.refunds,
            vec![
                json!({ "createdAt": "2026-08-11T00:00:00.000Z", "type": "Partial", "amount": 1.25,
                "origin": "BuyerInitiated", "products": [{ "amount": 1.25, "productId": "10", "skuId": "100" }] })
            ]
        );

        let mut partial = detail();
        partial["transaction"] = json!({ "productAmount": 12.5 });
        let partial = observe("seller-a", None, &fields(partial), AT).unwrap();
        assert_eq!(
            partial.transaction,
            Err("provider_transaction_fields_unavailable")
        );
        assert_eq!(
            partial.fingerprint,
            "b4ceee0c2de755db540b887383643ff930f3d924d0da9e8c6142ad4c91775c79"
        );

        let mut two = detail();
        two["refunds"] = json!([
            { "createdAt": "2026-08-12T00:00:00-04:00", "type": "Partial", "amount": 12,
              "products": [{ "amount": 12, "skuId": "9" }, { "amount": 1, "skuId": "10" }] },
            { "createdAt": "2026-08-11T00:00:00Z", "amount": 1 }
        ]);
        two["products"].as_array_mut().unwrap().push(json!(
            { "name": "Other", "unitPrice": 0.1, "extendedPrice": 0.3, "quantity": 3, "url": "", "productId": "", "skuId": "99" }
        ));
        two["transaction"]["feeAmount"] = json!(1.1);
        two["transaction"]["netAmount"] = json!(11.4);
        two["transaction"]["taxes"] = json!([{ "code": "TX", "amount": 0.07 }]);
        let two = observe("seller-a", None, &fields(two), AT).unwrap();
        assert_eq!(
            two.fingerprint,
            "dc40ada8f94fdf3877740ee962b04557c57dea1b537842b3f74768187a2ad3a9"
        );
        assert_eq!(
            two.refunds[1]["products"],
            json!([{ "amount": 1, "skuId": "10" }, { "amount": 12, "skuId": "9" }])
        );
    }

    #[test]
    fn lines_are_one_per_sku_in_order() {
        let line = |sku: &str, product: &str, name: &str, price: f64| Line {
            name: name.into(),
            unit_price: price,
            extended_price: price,
            quantity: 1.0,
            product_id: product.into(),
            sku_id: sku.into(),
        };
        let lines = [
            line("100", "", "", 6.25),
            line("100", "10", "Card", 6.25),
            line("20", "1", "A", 0.1),
        ];
        let aggregated = aggregate_lines(&lines).unwrap();
        assert_eq!(
            aggregated
                .iter()
                .map(|l| (l.sku_id.as_str(), l.quantity))
                .collect::<Vec<_>>(),
            [("100", 2.0), ("20", 1.0)]
        );
        assert_eq!(
            (
                aggregated[0].product_id.as_str(),
                aggregated[0].name.as_str(),
                aggregated[0].extended_price
            ),
            ("10", "Card", 12.5)
        );
        let mut reversed = lines.clone();
        reversed.reverse();
        assert_eq!(aggregate_lines(&reversed).unwrap()[0], aggregated[0]);
        assert!(
            aggregate_lines(&[line("1", "", "", -1.0)])
                .unwrap_err()
                .contains("invalid price")
        );
    }

    #[test]
    fn times_need_an_offset_and_are_written_in_utc() {
        assert_eq!(
            offset_timestamp("2026-08-10T10:00:00.440-04:00", "t").unwrap(),
            "2026-08-10T14:00:00.440Z"
        );
        assert_eq!(
            offset_timestamp("2026-08-11T00:00:00Z", "t").unwrap(),
            "2026-08-11T00:00:00.000Z"
        );
        assert!(
            offset_timestamp("2026-08-10T14:00:00", "t")
                .unwrap_err()
                .contains("UTC offset")
        );
        let mut equivalent = detail();
        equivalent["refunds"][0]["createdAt"] = json!("2026-08-10T20:00:00-04:00");
        assert_eq!(
            observe("s", None, &fields(equivalent), AT)
                .unwrap()
                .fingerprint,
            observe("s", None, &fields(detail()), AT)
                .unwrap()
                .fingerprint
        );
    }

    /// Every revision the Node app recorded, made into an observation again from what it stored,
    /// has the fingerprint Node stored. Reads the dev database; writes nothing.
    #[tokio::test]
    #[ignore = "reads the dev database's seller order revisions"]
    #[allow(
        clippy::type_complexity,
        reason = "one row of the query, read as a tuple"
    )]
    async fn recorded_revisions_fingerprint_as_the_node_app_did() {
        let db = crate::database::Database::connect_lazy(&crate::config::database_url());
        let rows: Vec<(
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            f64,
            Option<Value>,
            Value,
            Value,
            String,
        )> = sqlx::query_as(
            "SELECT o.order_number, o.seller_key,
                    to_char(r.order_time AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
                    r.refund_status, r.provider_status, o.order_channel, o.order_fulfillment,
                    o.gross_item_proceeds::float8, r.transaction_evidence, r.line_evidence,
                    r.refund_evidence, r.source_fingerprint
                 FROM seller_order_revisions r JOIN seller_orders o ON o.id = r.order_id
                 WHERE r.source = 'tcgplayer_api' AND r.revision_number = o.source_revision",
        )
        .fetch_all(&db.0)
        .await
        .unwrap();
        assert!(!rows.is_empty(), "the dev database has recorded orders");
        let mut differ = Vec::new();
        for (
            number,
            seller,
            at,
            refund_status,
            status,
            channel,
            fulfillment,
            gross,
            transaction,
            lines,
            refunds,
            stored,
        ) in &rows
        {
            let mut detail = json!({
                "orderNumber": number, "createdAt": at, "status": status,
                "refundStatus": refund_status, "orderChannel": channel, "orderFulfillment": fulfillment,
                "products": lines, "refunds": refunds,
                "transaction": transaction.clone().filter(|t| t.get("coverageReason").is_none())
                    .unwrap_or_else(|| json!({ "productAmount": gross })),
            });
            for key in ["refundStatus", "orderChannel", "orderFulfillment"] {
                if detail[key].is_null() {
                    detail.as_object_mut().unwrap().remove(key);
                }
            }
            let observed = observe(seller, None, &fields(detail), AT).unwrap();
            if &observed.fingerprint != stored {
                differ.push(number.clone());
            }
        }
        assert!(
            differ.is_empty(),
            "{} of {} differ: {:?}",
            differ.len(),
            rows.len(),
            &differ[..differ.len().min(5)]
        );
        println!(
            "{} recorded orders fingerprint as the Node app did",
            rows.len()
        );
    }

    #[test]
    fn a_status_is_a_lifecycle() {
        assert_eq!(lifecycle(" Shipped -  Delivered "), "shipped_delivered");
        assert_eq!(lifecycle("provider future status"), "unknown");
        assert!(needs_detail(None, "a"));
        assert!(needs_detail(Some(None), "a"));
        assert!(needs_detail(Some(Some("a")), "b"));
        assert!(!needs_detail(Some(Some("a")), "a"));
    }
}
