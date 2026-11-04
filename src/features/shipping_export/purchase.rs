//! Buying postage from EasyPost and recording it (`/api/shipping-export/postages`,
//! `purchaseShippingPostages`), and one PDF of labels already bought (`batch-labels`,
//! `generateBatchLabelForPurchasedShipments`), as the Node app's `easyPostPostage` did.
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    easypost::{Api, EasyPost, Failure},
    postage::{BatchLabel, BatchLabelStatus, Bill, Purchase, Rate, Scope, Status},
    shipments::{Direction, Planned, Shipment},
};
use crate::{
    database::Database,
    features::shipping_configuration::{Address, EasyPostMode, LabelSize},
};

/// How often, and how many times, a batch EasyPost is still making is asked about.
const BATCH_POLL_EVERY: Duration = Duration::from_secs(1);
const BATCH_POLLS: usize = 15;

const INVALID_SHIPMENT: &str = "Each shipment must include a valid USPS shipment payload, matching label size, and one or more order numbers.";

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn whole(a: &Address) -> bool {
    ![&a.name, &a.street1, &a.city, &a.state, &a.zip, &a.country]
        .iter()
        .any(|t| blank(t))
}

/// A shipment the Node route would take for `label_size` (`isValidShipment`).
fn valid(s: &Shipment, label_size: LabelSize) -> bool {
    let p = &s.parcel;
    !blank(&s.reference)
        && s.carrier == "USPS"
        && whole(&s.to_address)
        && whole(&s.from_address)
        && whole(&s.return_address)
        && [p.length, p.width, p.height, p.weight]
            .iter()
            .all(|n| n.is_finite())
        && !blank(&s.options.invoice_number)
        && s.options.label_size == label_size
}

/// The shipment as EasyPost creates it (`toEasyPostShipmentCreateParameters`).
fn create_parameters(s: &Shipment) -> Value {
    json!({
        "reference": s.reference,
        "to_address": s.to_address,
        "from_address": s.from_address,
        "parcel": {
            "length": s.parcel.length,
            "width": s.parcel.width,
            "height": s.parcel.height,
            "weight": s.parcel.weight,
            "predefined_package": s.parcel.predefined_package,
        },
        "options": {
            "label_format": s.options.label_format,
            "invoice_number": s.options.invoice_number,
            "delivery_confirmation": s.options.delivery_confirmation,
            "label_size": s.options.label_size,
        },
        "return_address": s.return_address,
    })
}

fn service_key(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_lowercase()
}

/// The cheapest of the shipment's carrier and service (`selectLowestMatchingRate`), the first
/// of equals.
fn lowest_rate<'a>(rates: &'a [Value], s: &Shipment) -> Option<&'a Value> {
    let service = service_key(serde_json::to_value(s.service).ok()?.as_str()?);
    let price = |r: &Value| {
        r["rate"]
            .as_str()
            .and_then(|t| t.trim().parse::<f64>().ok())
            .unwrap_or(f64::NAN)
    };
    rates
        .iter()
        .filter(|r| {
            r["carrier"]
                .as_str()
                .is_some_and(|c| c.to_uppercase() == s.carrier)
                && r["service"]
                    .as_str()
                    .is_some_and(|v| service_key(v) == service)
        })
        .fold(None, |best: Option<&Value>, r| match best {
            // A sort keeps equal (or incomparable) rates in order, so the first of them stays.
            Some(b) if price(r).partial_cmp(&price(b)) != Some(std::cmp::Ordering::Less) => Some(b),
            _ => Some(r),
        })
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn rate_of(r: &Value) -> Option<Rate> {
    Some(Rate {
        service: text(&r["service"])?,
        rate: text(&r["rate"])?,
        currency: text(&r["currency"])?,
    })
}

fn result(item: &Planned, status: Status, error: impl Into<String>) -> Purchase {
    Purchase {
        reference: item.shipment.reference.clone(),
        order_numbers: item.orders.clone(),
        status,
        easypost_shipment_id: None,
        tracking_code: None,
        selected_rate: None,
        label_url: None,
        label_pdf_url: None,
        error: Some(error.into()),
    }
}

/// A purchase as recorded, for a skip that names it.
#[derive(sqlx::FromRow)]
struct Recorded {
    order_numbers: Vec<String>,
    easypost_shipment_id: Option<String>,
    tracking_code: Option<String>,
    selected_rate_service: Option<String>,
    selected_rate_rate: Option<String>,
    selected_rate_currency: Option<String>,
    label_url: Option<String>,
    label_pdf_url: Option<String>,
}

/// Outbound postage already bought in `mode` for any of `orders` (`findSuccessfulOutboundByOrderNumbers`).
async fn bought_before(
    conn: &mut PgConnection,
    mode: EasyPostMode,
    orders: &[String],
) -> Result<Option<Recorded>, String> {
    sqlx::query_as(
        "SELECT order_numbers, easypost_shipment_id, tracking_code, selected_rate_service,
                selected_rate_rate, selected_rate_currency, label_url, label_pdf_url
         FROM shipping_postage_purchases
         WHERE mode = $1 AND direction = 'outbound' AND status = 'purchased'
           AND order_numbers && $2::text[]",
    )
    .bind(mode.name())
    .bind(orders)
    .fetch_optional(conn)
    .await
    .map_err(|e| format!("Error: {e}"))
}

/// Records what a purchase did for a shipment (`persistPurchaseResult`).
async fn record(
    conn: &mut PgConnection,
    mode: EasyPostMode,
    direction: Direction,
    label_size: LabelSize,
    r: &Purchase,
) -> Result<(), String> {
    let status = match r.status {
        Status::Purchased => "purchased",
        Status::Failed => "failed",
        Status::Skipped => "skipped",
    };
    let direction = match direction {
        Direction::Outbound => "outbound",
        Direction::Return => "return",
    };
    let rate = r.selected_rate.as_ref();
    sqlx::query(
        "INSERT INTO shipping_postage_purchases (shipment_reference, order_numbers, mode, direction,
           label_size, easypost_shipment_id, tracking_code, selected_rate_service, selected_rate_rate,
           selected_rate_currency, label_url, label_pdf_url, status, error_message)
         VALUES ($1, $2::text[], $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
    )
    .bind(&r.reference)
    .bind(&r.order_numbers)
    .bind(mode.name())
    .bind(direction)
    .bind(serde_json::to_value(label_size).ok().and_then(|v| v.as_str().map(str::to_owned)))
    .bind(&r.easypost_shipment_id)
    .bind(&r.tracking_code)
    .bind(rate.map(|r| &r.service))
    .bind(rate.map(|r| &r.rate))
    .bind(rate.map(|r| &r.currency))
    .bind(&r.label_url)
    .bind(&r.label_pdf_url)
    .bind(status)
    .bind(&r.error)
    .execute(conn)
    .await
    .map(drop)
    .map_err(|e| format!("Error: {e}"))
}

/// Buys one shipment's postage: its shipment created, the cheapest matching rate bought.
async fn bought(
    api: &impl Api,
    mode: EasyPostMode,
    item: &Planned,
    orders: Vec<String>,
) -> Purchase {
    let created = match api
        .post(
            mode,
            "shipments",
            &json!({ "shipment": create_parameters(&item.shipment) }),
        )
        .await
    {
        Ok(created) => created,
        Err(e) => return result(item, Status::Failed, e.formatted()),
    };
    let rates = created["rates"].as_array().cloned().unwrap_or_default();
    let Some(rate) = lowest_rate(&rates, &item.shipment) else {
        let service = serde_json::to_value(item.shipment.service)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        return result(
            item,
            Status::Failed,
            format!("No USPS {service} rate was available for this shipment."),
        );
    };
    let id = created["id"].as_str().unwrap_or_default();
    let body = json!({ "rate": { "id": rate["id"] } });
    match api.post(mode, &format!("shipments/{id}/buy"), &body).await {
        Ok(shipment) => Purchase {
            reference: item.shipment.reference.clone(),
            order_numbers: orders,
            status: Status::Purchased,
            easypost_shipment_id: text(&shipment["id"]),
            tracking_code: text(&shipment["tracking_code"]),
            selected_rate: rate_of(rate),
            label_url: text(&shipment["postage_label"]["label_url"]),
            label_pdf_url: text(&shipment["postage_label"]["label_pdf_url"]),
            error: None,
        },
        Err(e) => result(item, Status::Failed, e.formatted()),
    }
}

/// Buys postage for shipments of one label size in `mode` and records each result: an outbound
/// order bought before in bulk, or a shipment abroad, is skipped; a bulk outbound purchase makes
/// one PDF of its labels. Shipments the Node route would refuse are refused whole.
///
/// A result that cannot be recorded stops the run with that error, before any more postage is
/// bought: the duplicate check reads those records, so buying on could buy an order twice. Node
/// caught a failed record of a bought label and recorded it again as failed (keeping on when that
/// second insert worked, so a bought label was reported failed), and failed the whole request
/// when it did not, as a database that is down does.
pub async fn buy(
    conn: &mut PgConnection,
    api: &impl Api,
    mode: EasyPostMode,
    label_size: LabelSize,
    direction: Direction,
    scope: Scope,
    shipments: &[Planned],
) -> Result<Bill, String> {
    if shipments.is_empty() {
        return Err("shipments must be a non-empty array.".to_owned());
    }
    let items: Option<Vec<Planned>> = shipments
        .iter()
        .map(|p| {
            let orders: Vec<String> = p
                .orders
                .iter()
                .filter(|n| !blank(n))
                .map(|n| n.trim().to_owned())
                .collect();
            (!orders.is_empty() && valid(&p.shipment, label_size)).then(|| Planned {
                shipment: p.shipment.clone(),
                orders,
            })
        })
        .collect();
    let items = items.ok_or_else(|| INVALID_SHIPMENT.to_owned())?;
    let bulk_outbound = direction == Direction::Outbound && scope == Scope::Bulk;
    let mut results = Vec::new();
    for item in &items {
        let orders = item.orders.clone();
        let earlier = if bulk_outbound {
            bought_before(conn, mode, &orders).await?
        } else {
            None
        };
        let purchase = if let Some(earlier) = earlier {
            let rate = match (
                earlier.selected_rate_service.filter(|t| !t.is_empty()),
                earlier.selected_rate_rate.filter(|t| !t.is_empty()),
                earlier.selected_rate_currency.filter(|t| !t.is_empty()),
            ) {
                (Some(service), Some(rate), Some(currency)) => Some(Rate {
                    service,
                    rate,
                    currency,
                }),
                _ => None,
            };
            Purchase {
                easypost_shipment_id: earlier.easypost_shipment_id,
                tracking_code: earlier.tracking_code,
                selected_rate: rate,
                label_url: earlier.label_url,
                label_pdf_url: earlier.label_pdf_url,
                ..result(
                    item,
                    Status::Skipped,
                    format!(
                        "Postage already purchased in {} mode for order {}.",
                        mode.name(),
                        earlier
                            .order_numbers
                            .first()
                            .map_or("undefined", String::as_str)
                    ),
                )
            }
        } else if item.shipment.to_address.country.to_uppercase() != "US" {
            result(
                item,
                Status::Skipped,
                "Direct EasyPost purchase is limited to US domestic shipments in v1.",
            )
        } else {
            bought(api, mode, item, orders).await
        };
        record(conn, mode, direction, label_size, &purchase).await?;
        results.push(purchase);
    }
    let batch_label = if bulk_outbound {
        combined(api, mode, &results).await
    } else {
        BatchLabel {
            status: BatchLabelStatus::Skipped,
            shipment_references: results.iter().map(|r| r.reference.clone()).collect(),
            batch_id: None,
            label_url: None,
            message: Some(
                match scope {
                    Scope::Single => {
                        "Batch PDF generation is only available for bulk outbound purchases."
                    }
                    Scope::Bulk => "Batch PDF generation is only available for outbound purchases.",
                }
                .to_owned(),
            ),
        }
    };
    Ok(Bill {
        mode,
        batch_label,
        results,
    })
}

/// Buys postage in the deployment's mode from EasyPost, recorded in `db`.
pub async fn buy_from_easypost(
    db: &Database,
    label_size: LabelSize,
    direction: Direction,
    scope: Scope,
    shipments: &[Planned],
) -> Result<Bill, String> {
    let mut conn = db.0.acquire().await.map_err(|e| format!("Error: {e}"))?;
    let mode = EasyPostMode::of_deployment();
    buy(
        &mut conn,
        &EasyPost::default(),
        mode,
        label_size,
        direction,
        scope,
        shipments,
    )
    .await
}

/// One PDF of labels already bought in `mode`, by shipment reference and EasyPost's shipment id.
pub async fn batch_label(
    api: &impl Api,
    mode: EasyPostMode,
    labels: &[(&str, &str)],
) -> Result<BatchLabel, String> {
    if labels.is_empty() {
        return Err("shipments must be a non-empty array.".to_owned());
    }
    if labels.iter().any(|(r, id)| blank(r) || blank(id)) {
        return Err(
            "Each shipment must include a shipmentReference and easypostShipmentId.".to_owned(),
        );
    }
    let results: Vec<Purchase> = labels
        .iter()
        .map(|(reference, id)| Purchase {
            reference: reference.trim().to_owned(),
            order_numbers: vec![reference.trim().to_owned()],
            status: Status::Purchased,
            easypost_shipment_id: Some(id.trim().to_owned()),
            tracking_code: None,
            selected_rate: None,
            label_url: None,
            label_pdf_url: None,
            error: None,
        })
        .collect();
    Ok(combined(api, mode, &results).await)
}

fn state(batch: &Value) -> &str {
    batch["state"].as_str().unwrap_or("")
}

fn failed_state(batch: &Value) -> bool {
    matches!(state(batch), "creation_failed" | "purchase_failed")
}

/// Asks after the batch until `ready` or failed, at most [`BATCH_POLLS`] times; whether it
/// timed out.
async fn waited(
    api: &impl Api,
    mode: EasyPostMode,
    first: Value,
    ready: impl Fn(&Value) -> bool,
) -> Result<(Value, bool), Failure> {
    let id = first["id"].as_str().unwrap_or_default().to_owned();
    let mut batch = first;
    if ready(&batch) || failed_state(&batch) {
        return Ok((batch, false));
    }
    for _ in 0..BATCH_POLLS {
        tokio::time::sleep(BATCH_POLL_EVERY).await;
        batch = api.get(mode, &format!("batches/{id}")).await?;
        if ready(&batch) || failed_state(&batch) {
            return Ok((batch, false));
        }
    }
    Ok((batch, true))
}

/// One PDF of the results' labels (`createBatchLabel`).
async fn combined(api: &impl Api, mode: EasyPostMode, results: &[Purchase]) -> BatchLabel {
    let eligible: Vec<&Purchase> = results
        .iter()
        .filter(|r| {
            r.easypost_shipment_id
                .as_deref()
                .is_some_and(|id| !blank(id))
        })
        .collect();
    let references: Vec<String> = eligible.iter().map(|r| r.reference.clone()).collect();
    let mut ids: Vec<&str> = Vec::new();
    for r in &eligible {
        let id = r.easypost_shipment_id.as_deref().unwrap_or_default();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let label = |status,
                 batch_id: Option<&Value>,
                 label_url: Option<String>,
                 message: Option<String>| BatchLabel {
        status,
        shipment_references: references.clone(),
        batch_id: batch_id.and_then(|b| text(&b["id"])),
        label_url,
        message,
    };
    if ids.is_empty() {
        return label(
            BatchLabelStatus::Skipped,
            None,
            None,
            Some(
                "No purchased EasyPost shipments were available to combine into a batch PDF."
                    .to_owned(),
            ),
        );
    }
    let made = async {
        let created = api
            .post(mode, "batches", &json!({ "batch": { "shipments": ids } }))
            .await?;
        let ready = |b: &Value| matches!(state(b), "created" | "purchased" | "label_generated");
        let (batch, timed_out) = waited(api, mode, created, ready).await?;
        if failed_state(&batch) {
            let why = format!("EasyPost batch creation ended in {}.", state(&batch));
            return Ok(label(
                BatchLabelStatus::Failed,
                Some(&batch),
                None,
                Some(why),
            ));
        }
        if timed_out {
            let why = "EasyPost is still preparing the batch. Try opening the batch PDF again in a moment.";
            return Ok(label(
                BatchLabelStatus::Pending,
                Some(&batch),
                None,
                Some(why.to_owned()),
            ));
        }
        let id = batch["id"].as_str().unwrap_or_default().to_owned();
        let generated = api
            .post(
                mode,
                &format!("batches/{id}/label"),
                &json!({ "file_format": "PDF" }),
            )
            .await?;
        let has_label = |b: &Value| {
            state(b) == "label_generated" || b["label_url"].as_str().is_some_and(|u| !u.is_empty())
        };
        let (batch, timed_out) = waited(api, mode, generated, has_label).await?;
        if failed_state(&batch) {
            let why = format!(
                "EasyPost batch label generation ended in {}.",
                state(&batch)
            );
            return Ok(label(
                BatchLabelStatus::Failed,
                Some(&batch),
                None,
                Some(why),
            ));
        }
        if let Some(url) = batch["label_url"].as_str().filter(|u| !u.is_empty()) {
            return Ok(label(
                BatchLabelStatus::Ready,
                Some(&batch),
                Some(url.to_owned()),
                None,
            ));
        }
        let (status, why) = if timed_out {
            (
                BatchLabelStatus::Pending,
                "EasyPost is still generating the combined batch PDF.",
            )
        } else {
            (
                BatchLabelStatus::Failed,
                "EasyPost did not return a combined batch PDF URL.",
            )
        };
        Ok::<_, Failure>(label(status, Some(&batch), None, Some(why.to_owned())))
    };
    match made.await {
        Ok(label) => label,
        Err(e) => label(BatchLabelStatus::Failed, None, None, Some(e.formatted())),
    }
}
