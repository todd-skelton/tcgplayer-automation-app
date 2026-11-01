//! How far the seller's order history reaches (`getCoverage`): its latest scan of the API, as
//! the Node routes answer it. A seller never scanned is `not_started`.
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};

use crate::{database::Database, features::inventory_economics::ledger::proceeds::iso};

#[derive(sqlx::FromRow)]
struct Run {
    seller_key: String,
    source: String,
    status: String,
    search_range: Option<String>,
    observed_from: Option<DateTime<Utc>>,
    observed_through: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    expected_total: Option<i32>,
    orders_observed: i32,
    details_recorded: i32,
    next_offset: i32,
    gaps: Value,
    error: Option<String>,
}

/// The coverage of `seller`'s order history.
pub async fn coverage(db: &Database, seller: &str) -> sqlx::Result<Value> {
    let seller = seller.trim();
    let run: Option<Run> = sqlx::query_as(
        "SELECT seller_key, source, status, search_range, observed_from, observed_through,
           updated_at, finished_at, expected_total, orders_observed, details_recorded, next_offset,
           gaps, error
         FROM seller_order_sync_runs WHERE seller_key = $1 AND source = 'tcgplayer_api'
         ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&db.0)
    .await?;
    let Some(run) = run else {
        return Ok(json!({
            "sellerKey": seller,
            "source": "tcgplayer_api",
            "status": "not_started",
            "ordersObserved": 0,
            "detailsRecorded": 0,
            "gaps": [],
        }));
    };
    let mut c = Map::new();
    let mut set = |key: &str, value: Value| {
        c.insert(key.to_owned(), value);
    };
    set("sellerKey", run.seller_key.into());
    set("source", run.source.into());
    set("status", run.status.into());
    // Node leaves out what is missing, an empty range or error included.
    if let Some(range) = run.search_range.filter(|r| !r.is_empty()) {
        set("searchRange", range.into());
    }
    if let Some(at) = run.observed_from {
        set("observedFrom", iso(at).into());
    }
    if let Some(at) = run.observed_through {
        set("observedThrough", iso(at).into());
    }
    set("lastAttemptAt", iso(run.updated_at).into());
    if let Some(at) = run.finished_at {
        set("completedAt", iso(at).into());
    }
    if let Some(total) = run.expected_total {
        set("expectedTotal", total.into());
    }
    set("ordersObserved", run.orders_observed.into());
    set("detailsRecorded", run.details_recorded.into());
    set("nextOffset", run.next_offset.into());
    let gaps = run.gaps.as_array().cloned().unwrap_or_default();
    let numbers = gaps
        .iter()
        .map(|gap| gap.get("orderNumber").cloned().unwrap_or(Value::Null));
    set("gaps", Value::Array(numbers.collect()));
    if let Some(error) = run.error.filter(|e| !e.is_empty()) {
        set("error", error.into());
    }
    Ok(Value::Object(c))
}
