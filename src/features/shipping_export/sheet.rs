//! The batch's pull sheet, as TCGplayer exports it for the orders. The Pull Sheet and Pack steps
//! both read it, and Pack draws a page for every shipment packed, so the export is kept a few
//! minutes for the same orders rather than asked for on each page, as the React screen loaded it
//! once.
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::legacy::Legacy;

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

/// The pull sheet CSV for the orders, in the time zone `hours_ahead` of UTC.
pub async fn export(
    legacy: &Legacy,
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
        order_numbers: &'a [String],
        timezone_offset: f64,
    }
    let csv = legacy
        .send_for_file(
            "/api/shipping-export/pull-sheet-export",
            &Request {
                order_numbers: orders,
                timezone_offset: hours_ahead,
            },
        )
        .await?;
    let text = Arc::new(
        String::from_utf8_lossy(&csv.bytes)
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
