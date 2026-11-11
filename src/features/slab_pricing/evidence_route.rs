//! `/api/slab-evidence`: where evidence refreshes stand (`GET ?keys=`), a saved revision fifty
//! rows at a time (`GET ?revision=&offset=`), and queuing refreshes by `POST` (`research`,
//! `refresh`, `sale-detail`, `next-page`) or cancelling one (`cancel`), as the Node route
//! answered them, never stored by a cache.
//!
//! Node woke its in-process evidence worker after queuing, or when a read found a refresh queued
//! or running; this process cannot, so the worker must be running on its own, and it finds the
//! queue on its poll.
//!
//! A `refresh` answers its slabs in the order asked, where Node answered them in whatever order
//! the database read them. Where it can still differ from Node, on a request the Node app's own
//! client never sends: a research grade that is a number rather than text is refused here, where
//! Node researched it.
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, Utc};
use corten::{
    Api, JsonResponse, Prefix,
    http::Request,
    http::{StatusCode, header},
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    json_route::{same_origin, unstored},
    refreshes::{self, UNABLE, refused_or_unable, unable},
    research::Window,
};
use crate::{api, app::Shared, database::Database, features::slab_evidence::store};

/// The largest request Node read.
const MAX_BODY_BYTES: usize = 16 * 1024;
/// Rows a revision page holds.
const PAGE: usize = 50;

#[derive(Route)]
#[route("/api/slab-evidence")]
pub struct SlabEvidence {
    /// Every `revision`, `offset` and `keys` sent; Node read the first of each
    /// (`searchParams.get`).
    pub revision: Vec<String>,
    pub offset: Vec<String>,
    pub keys: Vec<String>,
}

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<SlabEvidence>(get(show).post(act).with_state(shared.clone()))
}

/// Node's `failure`: a refusal says why (400); the database failing is a 500.
fn failure(why: &str) -> JsonResponse {
    let status = if why == UNABLE {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::BAD_REQUEST
    };
    unstored(api::error(status, why))
}

/// A request that does not read: Node's `SyntaxError` or `TypeError`, a 400 saying only that
/// it was unable.
fn unreadable() -> JsonResponse {
    unstored(api::error(StatusCode::BAD_REQUEST, UNABLE))
}

fn answer(body: &Value) -> JsonResponse {
    unstored(api::node_json(body))
}

/// A revision page (`?revision=`), else `{ statuses }` of `?keys=`.
async fn show(State(db): State<Database>, Params(asked): Params<SlabEvidence>) -> JsonResponse {
    match db.0.acquire().await {
        Ok(mut conn) => {
            let first = |sent: &Vec<String>| sent.first().cloned();
            let (revision, offset, keys) = (
                first(&asked.revision),
                first(&asked.offset),
                first(&asked.keys),
            );
            read(&mut conn, revision, offset, keys).await
        }
        Err(error) => failure(&unable(error)),
    }
}

/// `revision`, `offset` and `keys` as Node read them, the first value sent of each.
async fn read(
    conn: &mut PgConnection,
    revision: Option<String>,
    offset: Option<String>,
    keys: Option<String>,
) -> JsonResponse {
    if let Some(revision) = revision.filter(|r| !r.is_empty()) {
        // `Number(offset ?? 0)`: a whole number from 0 to 2000.
        let offset = offset
            .map_or(Some(0.0), |o| api::js_number(&o))
            .filter(|o| o.fract() == 0.0 && (0.0..=2000.0).contains(o));
        let Some(offset) = offset else {
            return failure("Invalid evidence page.");
        };
        return match paged(conn, &revision, offset as usize).await {
            Ok(Some(page)) => answer(&page),
            Ok(None) => unstored(api::error(
                StatusCode::NOT_FOUND,
                "Evidence revision is no longer available.",
            )),
            Err(Paged::Refused(why)) => failure(&why),
            Err(Paged::Unreadable) => unreadable(),
        };
    }
    let keys = keys.unwrap_or_default();
    let keys: Vec<String> = keys
        .split(',')
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .collect();
    match store::statuses(conn, &keys).await {
        Ok(statuses) => answer(&json!({ "statuses": answered(&statuses) })),
        Err(error) => failure(&refused_or_unable(error)),
    }
}

fn answered(statuses: &[store::Status]) -> Vec<Value> {
    statuses.iter().map(store::Status::answered).collect()
}

/// Why a revision page was not read.
enum Paged {
    Refused(String),
    /// The saved data is not an object: Node's `TypeError`.
    Unreadable,
}

impl From<String> for Paged {
    fn from(why: String) -> Self {
        Paged::Refused(why)
    }
}

/// `getEvidenceRevision` as the route answered it: the revision, a supply revision with its scan's
/// listings; then, unless it is an Alt sale's details or has no rows, fifty of its sales or
/// listings from `offset` and where the page stands. None when it is gone.
async fn paged(conn: &mut PgConnection, id: &str, offset: usize) -> Result<Option<Value>, Paged> {
    let Some(mut record) = revision(conn, id).await? else {
        return Ok(None);
    };
    if record["payload"]["kind"] == "alt-sale-detail" {
        return Ok(Some(record));
    }
    let data = &mut record["payload"]["data"];
    if !data.is_object() {
        return Err(Paged::Unreadable);
    }
    let field = ["sales", "listings"]
        .into_iter()
        .find(|field| data.get(field).is_some());
    let Some(rows) = field.and_then(|f| data[f].as_array()) else {
        return Ok(Some(record));
    };
    let total = rows.len();
    let page: Vec<Value> = rows.iter().skip(offset).take(PAGE).cloned().collect();
    data[field.unwrap_or_default()] = Value::Array(page);
    let next = (offset + PAGE < total).then_some(offset + PAGE);
    record["page"] = json!({ "offset": offset, "total": total, "nextOffset": next });
    Ok(Some(record))
}

/// `getEvidenceRevision`: `{ id, key, payload, fetchedAt, bytes, observations }`, a supply
/// revision's listings read from its scan; none when the revision or its scan is gone.
async fn revision(conn: &mut PgConnection, id: &str) -> Result<Option<Value>, String> {
    let shaped = id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'));
    if !shaped {
        return Err("Provide an evidence revision.".to_owned());
    }
    type Record = (
        String,
        String,
        Value,
        DateTime<Utc>,
        i32,
        i32,
        Option<String>,
    );
    let row: Option<Record> = sqlx::query_as(
        "SELECT id::text, key, payload, fetched_at, byte_count, observation_count, supply_scan_id::text
         FROM slab_evidence_revisions WHERE id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unable)?;
    let Some((id, key, mut payload, fetched_at, bytes, observations, scan)) = row else {
        return Ok(None);
    };
    if let Some(scan) = scan {
        let scan: Option<(String, Value)> = sqlx::query_as(
            "SELECT s.source_key, COALESCE((SELECT jsonb_agg(v.payload ORDER BY o.position)
               FROM slab_supply_observations o JOIN slab_supply_versions v ON v.hash = o.version_hash
               WHERE o.scan_id = s.id), '[]'::jsonb)
             FROM slab_supply_scans s WHERE s.id = $1::uuid",
        )
        .bind(&scan)
        .fetch_optional(&mut *conn)
        .await
        .map_err(unable)?;
        let Some((source, listings)) = scan else {
            return Ok(None);
        };
        if source != key {
            return Err("Supply revision scope changed.".to_owned());
        }
        if !matches!(payload["kind"].as_str(), Some("alt-supply" | "ebay-supply")) {
            return Err("Invalid supply revision.".to_owned());
        }
        if payload["data"].is_object() {
            payload["data"]["listings"] = listings;
        }
    }
    Ok(Some(json!({
        "id": id,
        "key": key,
        "payload": payload,
        "fetchedAt": fetched_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        "bytes": bytes,
        "observations": observations,
    })))
}

/// A post from a page of the app's own origin, read as `readSlabJsonRequest` reads it.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let (parts, body) = request.into_parts();
    if !same_origin(&parts.headers) {
        let why = "Submit this request from the application.";
        return unstored(api::error(StatusCode::FORBIDDEN, why));
    }
    let json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    if !json.is_some_and(|t| t.starts_with("application/json")) {
        return unreadable();
    }
    let Ok(body) = crate::api::body_up_to(body, MAX_BODY_BYTES).await else {
        return unreadable();
    };
    // Not JSON, or `null`, whose fields are a TypeError.
    let input = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Null) | Err(_) => return unreadable(),
        Ok(input) => input,
    };
    match db.0.acquire().await {
        Ok(mut conn) => posted(&mut conn, &input).await,
        Err(error) => failure(&unable(error)),
    }
}

async fn posted(conn: &mut PgConnection, input: &Value) -> JsonResponse {
    match acted(conn, input).await {
        Ok(body) => answer(&body),
        Err(why) => failure(&why),
    }
}

/// The window asked: anything that is not two dates is refused as no dates are.
fn window(input: &Value) -> Window {
    let date = |end: &str| input["window"][end].as_str().unwrap_or_default().to_owned();
    Window {
        from: date("from"),
        to: date("to"),
    }
}

async fn acted(conn: &mut PgConnection, input: &Value) -> Result<Value, String> {
    let text = |key: &str| input[key].as_str().unwrap_or_default();
    let statuses = |queued: Vec<store::Status>| json!({ "statuses": answered(&queued) });
    match input["intent"].as_str().unwrap_or_default() {
        "research" => {
            // `Number.isSafeInteger` from 1.
            let revision = input["identityRevision"]
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0)
                .map_or(0, |n| n as i64);
            let (slab, grade, force) = (text("slabId"), text("grade"), input["force"] == true);
            let window = window(input);
            refreshes::research(conn, slab, revision, grade, &window, force)
                .await
                .map(statuses)
        }
        "cancel" => {
            let cancelled = store::cancel(&mut *conn, text("key"), text("runId"))
                .await
                .map_err(refused_or_unable)?;
            let cancelled: Vec<Value> = cancelled
                .into_iter()
                .map(|key| json!({ "key": key }))
                .collect();
            Ok(json!({ "cancelled": cancelled }))
        }
        "refresh" => {
            let started = Instant::now();
            let (supply, force) = (input["includeSupply"] == true, input["force"] == true);
            let refreshed =
                refreshes::slabs(conn, &input["slabIds"], &window(input), supply, force).await?;
            let count = |state: &str, stale: bool| {
                refreshed
                    .statuses
                    .iter()
                    .filter(|s| s.state == state && (stale || !s.stale))
                    .count()
            };
            Ok(json!({
                "slabs": refreshed.slabs,
                "statuses": answered(&refreshed.statuses),
                "metrics": {
                    "slabs": refreshed.records,
                    "uniqueRequests": refreshed.requests,
                    "fresh": count("idle", false),
                    "queued": count("queued", true),
                    "cacheMs": started.elapsed().as_millis(),
                },
            }))
        }
        "sale-detail" => refreshes::sale_detail(conn, text("revision"), text("transactionId"))
            .await
            .map(statuses),
        "next-page" => refreshes::next_page(conn, text("revision"))
            .await
            .map(statuses),
        _ => Err("Choose refresh, cancel, sale detail or next page.".to_owned()),
    }
}

#[cfg(test)]
mod tests {

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts slab-evidence`): reads of
    /// refreshes and revisions there are not, and every refusal before a write. What a post queues
    /// is compared with Node's in `refreshes::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-evidence", &[]).await;
    }
}
