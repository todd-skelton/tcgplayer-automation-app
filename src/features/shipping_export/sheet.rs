//! The batch's pull sheet and packing slips, as TCGplayer's order management API exports them for
//! the orders (`exportPullSheet`, `exportPackingSlips`). The Pull Sheet and Pack steps both read
//! the pull sheet, and Pack draws a page for every shipment packed, so the export is kept a few
//! minutes for the same orders rather than asked for on each page.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;

use crate::{
    database::Database,
    features::http_configuration::config::Domain,
    tcgplayer::{Call, TcgPlayer},
};

/// How long an export is used for the same orders.
const KEPT_FOR: Duration = Duration::from_secs(10 * 60);

struct Kept {
    orders: Vec<String>,
    hours_ahead: f64,
    at: Instant,
    text: Arc<String>,
}

/// The one batch there is, so one export is kept.
static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

/// Hours ahead of UTC as JavaScript writes the number: whole hours without a decimal point.
fn offset(hours_ahead: f64) -> Value {
    if hours_ahead.fract() == 0.0 && hours_ahead.abs() < 1e15 {
        Value::from(hours_ahead as i64)
    } else {
        Value::from(hours_ahead)
    }
}

/// The orders once each.
fn distinct(orders: &[String]) -> Vec<&str> {
    let mut seen = Vec::new();
    for order in orders.iter().map(|o| o.trim()).filter(|o| !o.is_empty()) {
        if !seen.contains(&order) {
            seen.push(order);
        }
    }
    seen
}

/// The pull sheet CSV for the orders, in the time zone `hours_ahead` of UTC.
pub async fn export(
    db: &Database,
    orders: &[String],
    hours_ahead: f64,
) -> Result<Arc<String>, String> {
    if orders.is_empty() {
        return Err("Load orders first.".into());
    }
    if let Some(kept) = KEPT.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && kept.orders == orders
        && kept.hours_ahead == hours_ahead
        && kept.at.elapsed() < KEPT_FOR
    {
        return Ok(kept.text.clone());
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        order_numbers: Vec<&'a str>,
        timezone_offset: Value,
    }
    let csv = TcgPlayer::new(db.clone())
        .post_for_bytes(
            Domain::OrderManagementApi,
            "/orders/pull-sheets/export?api-version=2.0",
            &Request {
                order_numbers: distinct(orders),
                timezone_offset: offset(hours_ahead),
            },
            // What axios asks for by default.
            "application/json, text/plain, */*",
            Call::default(),
        )
        .await
        .map_err(|why| why.to_string())?;
    let text = Arc::new(
        String::from_utf8_lossy(&csv)
            .trim_start_matches('\u{feff}')
            .to_owned(),
    );
    *KEPT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Kept {
        orders: orders.to_vec(),
        hours_ahead,
        at: Instant::now(),
        text: text.clone(),
    });
    Ok(text)
}

/// The orders' packing slips as one PDF, in release order, dated in the time zone
/// `hours_ahead` of UTC.
pub async fn packing_slips(
    db: &Database,
    orders: &[String],
    hours_ahead: f64,
) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        sorting_type: &'static str,
        format: &'static str,
        timezone_offset: Value,
        order_numbers: Vec<&'a str>,
    }
    let orders = distinct(orders);
    if orders.is_empty() {
        return Err("orderNumbers must include at least one order number.".into());
    }
    TcgPlayer::new(db.clone())
        .post_for_bytes(
            Domain::OrderManagementApi,
            "/orders/packing-slips/export?api-version=2.0",
            &Request {
                sorting_type: "ByRelease",
                format: "Default",
                timezone_offset: offset(hours_ahead),
                order_numbers: orders,
            },
            "application/pdf",
            Call::default(),
        )
        .await
        .map_err(|why| why.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offsets_and_orders_are_sent_as_the_node_route_sends_them() {
        assert_eq!(serde_json::to_string(&offset(-5.0)).unwrap(), "-5");
        assert_eq!(serde_json::to_string(&offset(5.5)).unwrap(), "5.5");
        let orders = [" A-1 ".to_owned(), "B-2".into(), "A-1".into(), "".into()];
        assert_eq!(distinct(&orders), ["A-1", "B-2"]);
    }
}
