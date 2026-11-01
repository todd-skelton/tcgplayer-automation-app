//! `/api/inventory-batches`: the newest batches made by hand (`GET`), one batch (`GET` and
//! `DELETE /{batch}`), its items (`GET /{batch}/items?scope=`), its saved results
//! (`GET /{batch}/results?scope=`) and its pricing (`POST /{batch}/pricing-jobs`), as the Node
//! routes answered them. Making a batch from the counted inventory (`POST`), making one from a
//! CSV or a seller (`/import-csv`, `/import-seller`) and saving results priced in the browser
//! (`POST /{batch}/results`, which no screen sends now) still go to the Node app, and so does
//! confirming an ambiguous publication item (`PATCH /{batch}/publications`). A batch's
//! publications and preview (`GET /{batch}/publications`) and planning its publication (`POST`)
//! are answered here.
//!
//! A batch's pricing stream (`GET /{batch}/pricing-stream`) is server-sent events of JSON: the
//! batch each time it changes, a heartbeat, and an error when there is no such batch. Corten
//! answers server-sent events only as live HTML patches (`corten::live`) or a feed's rows, so the
//! stream is a body of its own, sent as a `Relay`.
use std::{convert::Infallible, time::Duration};

use chrono::Utc;

use corten::{
    Api, JsonError, JsonResponse, Prefix, Relay,
    axum::{
        body::{Body, to_bytes},
        extract::{RawQuery, Request},
        http::{HeaderMap, HeaderValue, StatusCode, header},
    },
    prelude::*,
};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::batch_json;
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{
        batch_pricing::queue,
        continuous_pricing::scheduler,
        inventory_economics::ledger::fingerprint::js_json,
        inventory_intake::queue::{self as intake, NotQueued},
        inventory_publication::{plan, preview, publication_json},
        shipping_configuration,
    },
    legacy::{Legacy, relay_request},
    node_pg,
};

#[derive(Route)]
#[route("/api/inventory-batches")]
pub struct InventoryBatches;

/// Static, so a batch's route does not take them for a batch: still the Node app's.
#[derive(Route)]
#[route("/api/inventory-batches/import-csv")]
pub struct ImportCsv;

#[derive(Route)]
#[route("/api/inventory-batches/import-seller")]
pub struct ImportSeller;

#[derive(Route)]
#[route("/api/inventory-batches/{batch}")]
pub struct InventoryBatch<'a> {
    pub batch: &'a str,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/items")]
pub struct InventoryBatchItems<'a> {
    pub batch: &'a str,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/results")]
pub struct InventoryBatchResults<'a> {
    pub batch: &'a str,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/pricing-jobs")]
pub struct InventoryBatchPricingJobs<'a> {
    pub batch: &'a str,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/publications")]
pub struct InventoryBatchPublications<'a> {
    pub batch: &'a str,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/pricing-stream")]
pub struct InventoryBatchPricingStream<'a> {
    pub batch: &'a str,
}

/// How often the pricing stream reads the batch, and how often it sends a heartbeat.
const STREAM_POLL: Duration = Duration::from_secs(1);
const STREAM_HEARTBEAT: Duration = Duration::from_secs(15);

/// The largest batch request read: a request id and a purchase total.
const MAX_CREATE_BODY_BYTES: usize = 64 * 1024;

/// The largest pricing request read: it holds only a mode.
const MAX_PRICING_BODY_BYTES: usize = 64 * 1024;

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryBatches>(
        get(list)
            .post(create)
            .put(list_not_allowed)
            .patch(list_not_allowed)
            .delete(list_not_allowed)
            .with_state(shared.clone()),
    )
    .route::<ImportCsv>(relayed().with_state(shared.clone()))
    .route::<ImportSeller>(relayed().with_state(shared.clone()))
    .route::<InventoryBatch<'_>>(
        get(one)
            .delete(delete)
            .post(not_allowed)
            .put(not_allowed)
            .patch(not_allowed)
            .with_state(shared.clone()),
    )
    .route::<InventoryBatchItems<'_>>(get(items).with_state(shared.clone()))
    .route::<InventoryBatchResults<'_>>(
        get(results)
            .post(relay)
            .put(relay)
            .patch(relay)
            .delete(relay)
            .with_state(shared.clone()),
    )
    .route::<InventoryBatchPricingJobs<'_>>(
        post(price)
            .put(pricing_not_allowed)
            .patch(pricing_not_allowed)
            .delete(pricing_not_allowed)
            .with_state(shared.clone()),
    )
    .route::<InventoryBatchPricingStream<'_>>(get(pricing_stream).with_state(shared.clone()))
    .route::<InventoryBatchPublications<'_>>(
        get(publications)
            .post(publish)
            .patch(relay)
            .put(publications_not_allowed)
            .delete(publications_not_allowed)
            .with_state(shared.clone()),
    )
}

/// Every method the relay at `/api/{*rest}` takes, sent on to the Node app.
fn relayed() -> Methods<Shared> {
    get(relay).post(relay).put(relay).patch(relay).delete(relay)
}

/// The request sent to the Node app, its answer passed on as it came.
async fn relay(State(legacy): State<Legacy>, request: Request) -> Result<JsonResponse, JsonError> {
    Ok(relay_request(&legacy, request).await?.into())
}

/// `parseBatchNumber`: `Number(raw)`, a whole number above zero. One past a Postgres `integer`
/// was sent on to the database, whose error node-pg answered.
fn batch_number(raw: &str) -> Result<i32, Refused> {
    let n = api::js_number(raw)
        .filter(|n| n.fract() == 0.0 && *n > 0.0)
        .ok_or(Refused::Invalid)?;
    i32::try_from(n as i64).map_err(|_| Refused::OutOfRange(n as i64))
}

/// Why a batch number in the path was refused.
#[derive(Clone, Copy, Debug)]
enum Refused {
    Invalid,
    OutOfRange(i64),
}

impl From<Refused> for JsonResponse {
    fn from(refused: Refused) -> Self {
        match refused {
            Refused::Invalid => api::error(StatusCode::BAD_REQUEST, "Invalid batch number"),
            Refused::OutOfRange(n) => failed(format!(
                "error: value \"{n}\" is out of range for type integer"
            )),
        }
    }
}

fn failed(error: impl std::fmt::Display) -> JsonResponse {
    api::error(StatusCode::INTERNAL_SERVER_ERROR, error)
}

fn not_found(batch: i32) -> JsonResponse {
    api::error(StatusCode::NOT_FOUND, format!("Batch {batch} not found"))
}

/// The newest 100 batches made by hand, each with its latest pricing job.
async fn list(State(db): State<Database>) -> JsonResponse {
    let listed = match db.0.acquire().await {
        Ok(mut conn) => batch_json::recent(&mut conn).await,
        Err(error) => Err(node_pg::thrown(error)),
    };
    match listed {
        Ok(batches) => api::node_json(&batches),
        Err(error) => failed(error),
    }
}

/// Any other write to the list: Node's action.
async fn list_not_allowed() -> JsonResponse {
    api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
}

/// The counts as a batch, in a transaction kept only when the batch is answered.
async fn create(State(db): State<Database>, request: Request) -> JsonResponse {
    let body = match to_bytes(request.into_body(), MAX_CREATE_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return failed(format!("Error: {error}")),
    };
    // `getShippingExportConfig` answers its defaults when the saved one cannot be read.
    let seller = shipping_configuration::default_seller_key(&db)
        .await
        .unwrap_or_default();
    let mut tx = match db.0.begin().await {
        Ok(tx) => tx,
        Err(error) => return failed(node_pg::thrown(error)),
    };
    match batch_created(&mut tx, &body, api::js_trim(&seller)).await {
        Ok(answer) => match tx.commit().await {
            Ok(()) => answer,
            Err(error) => failed(node_pg::thrown(error)),
        },
        Err(answer) => {
            let _ = tx.rollback().await;
            *answer
        }
    }
}

/// The action of `POST /api/inventory-batches`: the body's request id checked, then the batch
/// it makes (see [`intake::created`]) answered, or why not, each in Node's words and status.
async fn batch_created(
    conn: &mut PgConnection,
    body: &[u8],
    seller: &str,
) -> Result<JsonResponse, Box<JsonResponse>> {
    // `request.json()`, a body that is not JSON read as none.
    let payload: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .map_or("", api::js_trim);
    if request_id.is_empty() || request_id.encode_utf16().count() > 200 {
        return Err(Box::new(api::error(
            StatusCode::BAD_REQUEST,
            "requestId is required",
        )));
    }
    let purchase = payload.get("purchaseCost").filter(|cost| truthy(cost));
    let batch = intake::created(conn, request_id, purchase, seller)
        .await
        .map_err(|not| {
            Box::new(match not {
                NotQueued::Refused(corten::Refusal::Conflict, why) => {
                    api::error(StatusCode::CONFLICT, why)
                }
                NotQueued::Refused(_, why) => api::error(StatusCode::BAD_REQUEST, why),
                NotQueued::Unrecorded(why) => failed(format!("Error: {why}")),
                NotQueued::Failed(why) => failed(why),
            })
        })?;
    match batch_json::find(conn, batch).await {
        Ok(Some(found)) => Ok(api::node_json(&found).with_status(StatusCode::CREATED)),
        Ok(None) => Err(Box::new(not_found(batch))),
        Err(error) => Err(Box::new(failed(error))),
    }
}

/// JavaScript's truthiness, which decides whether a purchase cost was entered.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

async fn one(State(db): State<Database>, Params(at): Params<InventoryBatch<'_>>) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let found = match db.0.acquire().await {
        Ok(mut conn) => batch_json::find(&mut conn, batch).await,
        Err(error) => Err(node_pg::thrown(error)),
    };
    match found {
        Ok(Some(found)) => api::node_json(&found),
        Ok(None) => not_found(batch),
        Err(error) => failed(error),
    }
}

async fn delete(
    State(db): State<Database>,
    Params(at): Params<InventoryBatch<'_>>,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    match db.0.acquire().await {
        Ok(mut conn) => deleted(&mut conn, batch).await,
        Err(error) => failed(node_pg::thrown(error)),
    }
}

/// `deleteBatch`: the batch with its items, results and pricing jobs. The database refuses a
/// published batch, which its publications keep.
async fn deleted(conn: &mut PgConnection, batch: i32) -> JsonResponse {
    let deleted = sqlx::query("DELETE FROM inventory_batches WHERE batch_number = $1")
        .bind(batch)
        .execute(conn)
        .await;
    match deleted {
        Ok(done) if done.rows_affected() == 0 => not_found(batch),
        Ok(_) => api::node_json(&json!({ "message": format!("Batch {batch} deleted") })),
        Err(error) => failed(node_pg::thrown(error)),
    }
}

/// Any other write: Node's action, which read the batch number first.
async fn not_allowed(Params(at): Params<InventoryBatch<'_>>) -> JsonResponse {
    match batch_number(&at.batch) {
        Ok(_) => api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
        Err(refused) => refused.into(),
    }
}

async fn items(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchItems<'_>>,
    RawQuery(query): RawQuery,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let errors = api::first(query.as_deref(), "scope").as_deref() == Some("errors");
    let listed = match db.0.acquire().await {
        Ok(mut conn) => batch_json::items(&mut conn, batch, errors).await,
        Err(error) => Err(node_pg::thrown(error)),
    };
    match listed {
        Ok(items) => api::node_json(&items),
        Err(error) => failed(error),
    }
}

/// `?scope=manual-review`: the results that need a look; anything else, the successful ones.
async fn results(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchResults<'_>>,
    RawQuery(query): RawQuery,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let manual_review = api::first(query.as_deref(), "scope").as_deref() == Some("manual-review");
    let listed = match db.0.acquire().await {
        Ok(mut conn) => batch_json::results(&mut conn, batch, manual_review).await,
        Err(error) => Err(node_pg::thrown(error)),
    };
    match listed {
        Ok(results) => api::node_json(&results),
        Err(error) => failed(error),
    }
}

/// `createOrReuseActiveJob` under the pricing configuration as it is now: the job queued, or the
/// one already queued or pricing, with 202. The pricing worker claims it from the queue.
async fn price(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchPricingJobs<'_>>,
    request: Request,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let body = match to_bytes(request.into_body(), MAX_PRICING_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return failed(format!("Error: {error}")),
    };
    let mut tx = match db.0.begin().await {
        Ok(tx) => tx,
        Err(error) => return failed(node_pg::thrown(error)),
    };
    let answer = queued(&mut tx, batch, &body).await;
    match tx.commit().await {
        Ok(()) => answer,
        Err(error) => failed(node_pg::thrown(error)),
    }
}

/// The pricing a request asks for, in Node's order: the batch, then the body's `mode`.
async fn queued(conn: &mut PgConnection, batch: i32, body: &[u8]) -> JsonResponse {
    match batch_json::find(conn, batch).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found(batch),
        Err(error) => return failed(error),
    }
    let payload: Value = match serde_json::from_slice(body) {
        Ok(payload) => payload,
        Err(error) => return failed(format!("SyntaxError: {error}")),
    };
    if payload.is_null() {
        return failed("TypeError: Cannot read properties of null (reading 'mode')");
    }
    let Some(mode) = payload["mode"]
        .as_str()
        .filter(|m| matches!(*m, "full" | "errors"))
    else {
        return api::error(StatusCode::BAD_REQUEST, "Invalid pricing mode");
    };
    let job = async {
        let config = scheduler::job_config_on(&mut *conn)
            .await
            .map_err(node_pg::thrown)?;
        let Some(queued) = queue::create_or_reuse(conn, batch, mode, &config)
            .await
            .map_err(node_pg::thrown)?
        else {
            return Ok(None);
        };
        batch_json::job(conn, queued.id).await.map(Some)
    };
    match job.await {
        Ok(Some(job)) => api::node_json(&job).with_status(StatusCode::ACCEPTED),
        Ok(None) => not_found(batch),
        Err(error) => failed(error),
    }
}

/// Any other write to a batch's pricing jobs: Node's action, which read the batch number first.
async fn pricing_not_allowed(Params(at): Params<InventoryBatchPricingJobs<'_>>) -> JsonResponse {
    match batch_number(&at.batch) {
        Ok(_) => api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
        Err(refused) => refused.into(),
    }
}

/// The batch as it changes while it is priced, until the client leaves.
async fn pricing_stream(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchPricingStream<'_>>,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    let events = pricing_events(db, batch).map(Ok::<_, Infallible>);
    Relay::new(StatusCode::OK, headers, Body::from_stream(events)).into()
}

/// A pricing stream's state: the batch it watches and the version of it last sent.
struct Watching {
    db: Database,
    batch: i32,
    poll: tokio::time::Interval,
    heartbeat: tokio::time::Interval,
    sent: Option<Value>,
    ended: bool,
}

/// The stream's events: the batch now, again each time it changes (read every second), and a
/// heartbeat every 15 seconds; an `error` event ends it when the batch is not there.
fn pricing_events(db: Database, batch: i32) -> impl Stream<Item = String> + Send + 'static {
    let mut poll = tokio::time::interval(STREAM_POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let start = tokio::time::Instant::now() + STREAM_HEARTBEAT;
    let watching = Watching {
        db,
        batch,
        poll,
        heartbeat: tokio::time::interval_at(start, STREAM_HEARTBEAT),
        sent: None,
        ended: false,
    };
    futures_util::stream::unfold(watching, |mut watching| async move {
        if watching.ended {
            return None;
        }
        loop {
            tokio::select! {
                _ = watching.poll.tick() => if let Some(event) = watching.snapshot().await {
                    return Some((event, watching));
                },
                _ = watching.heartbeat.tick() => {
                    return Some((sse_event("heartbeat", &json!({})), watching));
                }
            }
        }
    })
}

impl Watching {
    /// The batch's event when it changed since the last one sent; none when it did not, or the
    /// read failed (Node's interval dropped that failure too, and read again a second later).
    async fn snapshot(&mut self) -> Option<String> {
        let found = match self.db.0.acquire().await {
            Ok(mut conn) => batch_json::find(&mut conn, self.batch).await,
            Err(error) => Err(node_pg::thrown(error)),
        };
        match found {
            Ok(Some(batch)) => {
                let version = batch_version(&batch);
                if self.sent.as_ref() == Some(&version) {
                    return None;
                }
                self.sent = Some(version);
                Some(sse_event("batch", &json!({ "batch": batch })))
            }
            Ok(None) => {
                self.ended = true;
                let error = format!("Batch {} not found", self.batch);
                Some(sse_event("error", &json!({ "error": error })))
            }
            Err(error) => {
                eprintln!("Pricing stream for batch {}: {error}", self.batch);
                None
            }
        }
    }
}

/// `getBatchVersion`: what a change the screen shows changes.
fn batch_version(batch: &Value) -> Value {
    let job = &batch["latestJob"];
    json!([
        batch["updatedAt"],
        batch["status"],
        batch["lastPricedAt"],
        job["id"],
        job["status"],
        job["updatedAt"],
        job["errorMessage"],
    ])
}

/// One server-sent event, its data written as `JSON.stringify` writes it.
fn sse_event(name: &str, payload: &Value) -> String {
    format!("event: {name}\ndata: {}\n\n", js_json(payload))
}

/// The batch's publications, newest first, and what publishing its completed pricing job would
/// plan under the saved policy (`null` before it completed).
async fn publications(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchPublications<'_>>,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let answer = match db.0.acquire().await {
        Ok(mut conn) => shown_publications(&mut conn, batch).await,
        Err(error) => Err(node_pg::thrown(error)),
    };
    match answer {
        Ok(Some(answer)) => api::node_json(&answer),
        Ok(None) => not_found(batch),
        Err(error) => failed(error),
    }
}

/// `{ preview, publications }`, or none when there is no such batch.
async fn shown_publications(conn: &mut PgConnection, batch: i32) -> Result<Option<Value>, String> {
    let Some((found, items, results)) =
        preview::load(conn, batch).await.map_err(node_pg::thrown)?
    else {
        return Ok(None);
    };
    let publications = publication_json::for_batch(conn, batch).await?;
    let policy = plan::Configuration::load(conn)
        .await
        .map_err(node_pg::thrown)?
        .policy;
    let preview = if found.job_status.as_deref() == Some("completed") {
        let known = preview::known(conn, batch, &items, &results, None)
            .await
            .map_err(node_pg::thrown)?;
        preview::preview(&found, &items, &results, &known, &policy, Utc::now(), false)
            .map_err(|why| format!("Error: {why}"))?
            .json()
    } else {
        Value::Null
    };
    Ok(Some(
        json!({ "preview": preview, "publications": publications }),
    ))
}

/// Plans the batch's selected SKUs (every eligible one when none are sent) for publication: 201
/// when a publication was made, 200 when each was planned before. Node's publisher sends them.
async fn publish(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchPublications<'_>>,
    request: Request,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let body = match to_bytes(request.into_body(), MAX_PUBLISH_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return failed(format!("Error: {error}")),
    };
    match db.0.acquire().await {
        Ok(mut conn) => published(&mut conn, batch, &body).await,
        Err(error) => failed(node_pg::thrown(error)),
    }
}

/// What a publish request with `body` answers.
async fn published(conn: &mut PgConnection, batch: i32, body: &[u8]) -> JsonResponse {
    let Ok(selected) = selected_skus(body) else {
        return api::error(
            StatusCode::BAD_REQUEST,
            "selectedSkus must contain valid SKU numbers",
        );
    };
    planned(conn, batch, selected.as_deref()).await
}

/// The largest publish request read: a selection of SKUs.
const MAX_PUBLISH_BODY_BYTES: usize = 4 * 1024 * 1024;

/// The body's `selectedSkus`: none when it is not sent (or the body is not a JSON object, which
/// publishes every eligible SKU, as Node's did); refused unless a list of whole numbers above
/// zero.
fn selected_skus(body: &[u8]) -> Result<Option<Vec<i64>>, ()> {
    let Ok(Value::Object(body)) = serde_json::from_slice::<Value>(body) else {
        return Ok(None);
    };
    let Some(selected) = body.get("selectedSkus") else {
        return Ok(None);
    };
    let skus = selected.as_array().ok_or(())?;
    skus.iter()
        .map(|sku| {
            sku.as_f64()
                .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
                .map(|n| n as i64)
                .ok_or(())
        })
        .collect::<Result<Vec<_>, ()>>()
        .map(Some)
}

/// `planInventoryBatchPublications`'s answer: the publications, the preview and how many were made.
async fn planned(conn: &mut PgConnection, batch: i32, selected: Option<&[i64]>) -> JsonResponse {
    let planned = match plan::plan_manual(conn, batch, selected, Utc::now()).await {
        Ok(planned) => planned,
        Err(plan::Error::Rejected(why)) => return failed(format!("Error: {why}")),
        Err(plan::Error::Database(error)) => return failed(node_pg::thrown(error)),
    };
    let publications = match publication_json::by_ids(conn, &planned.publication_ids).await {
        Ok(publications) => publications,
        Err(error) => return failed(error),
    };
    let status = if planned.created > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    api::node_json(&json!({
        "publications": publications,
        "preview": planned.preview.json(),
        "createdCount": planned.created,
    }))
    .with_status(status)
}

/// Any other write to a batch's publications: Node's action, which read the batch number first.
async fn publications_not_allowed(
    Params(at): Params<InventoryBatchPublications<'_>>,
) -> JsonResponse {
    match batch_number(&at.batch) {
        Ok(_) => api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
        Err(refused) => refused.into(),
    }
}

#[cfg(test)]
mod tests {
    use corten::axum::response::IntoResponse;
    use serde_json::Value;
    use sqlx::Connection;

    use super::*;

    /// Node's pricing stream on dev batches (`.port-logs/pricing-stream-node.ts`), through the
    /// app's router: the status and headers, and what it sent first, the batch or the error event,
    /// or its JSON refusal.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_pricing_stream_starts_as_node_started_it() {
        use http_body_util::BodyExt;
        crate::config::load_env();
        let read = std::fs::read_to_string(".port-logs/pricing-stream.node.json").unwrap();
        let node: Vec<Value> = serde_json::from_str(&read).unwrap();
        let router = crate::app::app(Shared {
            db: Database::connect_lazy(&crate::config::database_url()),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: crate::features::slab_connections::Transport::default(),
        })
        .router();
        let event = |text: &str| -> (String, Value) {
            let (name, data) = text.trim_end().split_once('\n').unwrap();
            let data = data.strip_prefix("data: ").unwrap();
            (name.to_owned(), serde_json::from_str(data).unwrap())
        };
        for theirs in &node {
            let batch = theirs["batch"].as_str().unwrap();
            let path = format!("/api/inventory-batches/{batch}/pricing-stream");
            let request = corten::axum::http::Request::get(&path)
                .body(Body::empty())
                .unwrap();
            let answer = tower::ServiceExt::oneshot(router.clone(), request)
                .await
                .unwrap();
            assert_eq!(
                u64::from(answer.status().as_u16()),
                theirs["status"],
                "{path}"
            );
            let kind = answer.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .to_owned();
            assert!(
                kind.starts_with(theirs["contentType"].as_str().unwrap()),
                "{path}: {kind}"
            );
            if let Some(cache) = theirs["cacheControl"].as_str() {
                assert_eq!(answer.headers()[header::CACHE_CONTROL], cache, "{path}");
            }
            let mut body = answer.into_body();
            let mut text = String::new();
            while !text.ends_with("\n\n") && !kind.starts_with("application/json") {
                let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
                    .await
                    .unwrap();
                let Some(frame) = frame else { break };
                if let Ok(data) = frame.unwrap().into_data() {
                    text.push_str(std::str::from_utf8(&data).unwrap());
                }
            }
            let expected = theirs["text"].as_str().unwrap();
            if kind.starts_with("application/json") {
                let bytes = body.collect().await.unwrap().to_bytes();
                let ours: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(
                    ours,
                    serde_json::from_str::<Value>(expected).unwrap(),
                    "{path}"
                );
            } else {
                assert_eq!(event(&text), event(expected), "{path}");
            }
        }
    }

    /// Node's publish route over `.port-logs/publish-route.node.json` (`publish-route-node.ts`: the
    /// cases of `publish-cases.json`, then refusals of the body), each after its setup in a
    /// savepoint rolled back after it: the status and the whole answer, but the ids and times of
    /// the publications each run makes.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn publishes_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = std::fs::read_to_string(".port-logs/publish-route.node.json").unwrap();
        let node: Vec<Value> = serde_json::from_str(&read).unwrap();
        let unmade = |mut body: Value| {
            for publication in body["publications"].as_array_mut().into_iter().flatten() {
                for key in ["id", "createdAt", "updatedAt"] {
                    publication[key] = Value::Null;
                }
                for item in publication["items"].as_array_mut().into_iter().flatten() {
                    for key in ["id", "publicationId", "createdAt", "updatedAt"] {
                        item[key] = Value::Null;
                    }
                }
            }
            body
        };
        let mut tx = db.0.begin().await.unwrap();
        for case in &node {
            let name = &case["name"];
            let mut each = tx.begin().await.unwrap();
            if let Some(setup) = case["setup"].as_str() {
                sqlx::raw_sql(setup).execute(&mut *each).await.unwrap();
            }
            let batch = case["batch"].to_string();
            let body = case["body"].as_str().unwrap().as_bytes();
            for theirs in case["answers"].as_array().unwrap() {
                let answer = match batch_number(&batch) {
                    Ok(batch) => published(&mut each, batch, body).await,
                    Err(refused) => refused.into(),
                }
                .into_response();
                let status = answer.status().as_u16();
                let bytes = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let ours: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(u64::from(status), theirs["status"], "{name}");
                assert_eq!(
                    unmade(crate::api::tests::node_numbers(&ours)),
                    unmade(theirs["body"].clone()),
                    "{name}"
                );
            }
            each.rollback().await.unwrap();
        }
        tx.rollback().await.unwrap();
    }

    /// The pricing requests in `.port-logs/pricing-jobs-cases.json` on the dev database, in order in
    /// one transaction rolled back, against Node's action over the same
    /// (`.port-logs/pricing-jobs-node.ts`): the answer, and batch 146's status after it. A job
    /// queued in each run has its own id and times; one queued in one case is the one the next
    /// case for its batch reuses.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn pricing_requests_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("pricing-jobs-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("pricing-jobs.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut ids = std::collections::HashMap::new();
        let mut tx = db.0.begin().await.unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = &case["name"];
            let answer = match batch_number(case["batch"].as_str().unwrap()) {
                Ok(batch) => queued(&mut tx, batch, case["body"].to_string().as_bytes()).await,
                Err(refused) => refused.into(),
            };
            let status: Option<String> =
                sqlx::query_scalar("SELECT status FROM inventory_batches WHERE batch_number = 146")
                    .fetch_optional(&mut *tx)
                    .await
                    .unwrap();
            let answer = answer.into_response();
            let code = answer.status().as_u16();
            let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                .await
                .unwrap();
            let mut ours: Value = serde_json::from_slice(&body).unwrap();
            let mut expected = theirs["body"].clone();
            if ours["id"] != expected["id"] {
                let mapped = ids
                    .entry(expected["id"].clone())
                    .or_insert(ours["id"].clone());
                assert_eq!(*mapped, ours["id"], "{name}: not the job queued before");
                for timed in ["/id", "/createdAt", "/updatedAt"] {
                    *ours.pointer_mut(timed).unwrap() = Value::Null;
                    *expected.pointer_mut(timed).unwrap() = Value::Null;
                }
            }
            assert_eq!(u64::from(code), theirs["status"], "{name}");
            assert_eq!(ours, expected, "{name}");
            assert_eq!(Value::from(status), theirs["batch146"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// The requests in `.port-logs/batch-create-cases.json`, from the counts
    /// `.port-logs/pending-seed.sql` leaves, inside a transaction rolled back (a savepoint each),
    /// against Node's action over the same (`.port-logs/batch-create-node.ts`): each answer, the
    /// batch it made, and the batches, lots and costs left. A case's seller is the saved one
    /// unless the case names another.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn creates_as_node_created() {
        use crate::features::inventory_intake::queue::tests::{fingerprints_checked, untimed};
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("batch-create-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("batch-create.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let saved = shipping_configuration::default_seller_key(&db)
            .await
            .unwrap();
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read_log("pending-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let capture = read_log("batch-create-capture.sql");
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let seller = case["seller"].as_str().unwrap_or(api::js_trim(&saved));
            let mut each = tx.begin().await.unwrap();
            if let Some(setup) = case["setup"].as_str() {
                sqlx::raw_sql(setup).execute(&mut *each).await.unwrap();
            }
            let mut batches: Vec<i64> = Vec::new();
            let mut answers = Vec::new();
            let mut bodies = Vec::new();
            for step in case["steps"].as_array().unwrap() {
                if let Some(sql) = step["sql"].as_str() {
                    sqlx::raw_sql(sql).execute(&mut *each).await.unwrap();
                    continue;
                }
                let body = step["body"].as_str().unwrap().as_bytes();
                let mut attempt = each.begin().await.unwrap();
                let answer = batch_created(&mut attempt, body, seller).await;
                match answer {
                    Ok(_) => attempt.commit().await.unwrap(),
                    Err(_) => attempt.rollback().await.unwrap(),
                }
                let answer = answer.unwrap_or_else(|refused| *refused).into_response();
                let status = answer.status().as_u16();
                let bytes = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let answered: Value = serde_json::from_slice(&bytes).unwrap();
                let label = |batches: &[i64], n: i64| {
                    format!("B{}", batches.iter().position(|b| *b == n).unwrap() + 1)
                };
                if status == 201 {
                    let n = answered["batchNumber"].as_i64().unwrap();
                    if !batches.contains(&n) {
                        batches.push(n);
                    }
                    answers.push(json!({ "status": status, "batch": label(&batches, n) }));
                    bodies.push(untimed(answered, &label(&batches, n)));
                } else {
                    let mut error = answered["error"].as_str().unwrap().to_owned();
                    if let Some((before, n)) = error.rsplit_once("batch ")
                        && let Ok(n) = n.parse::<i64>()
                        && batches.contains(&n)
                    {
                        error = format!("{before}batch {}", label(&batches, n));
                    }
                    answers.push(json!({ "status": status, "error": error }));
                }
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(Value::from(answers), theirs["answers"], "{name}");
            let node_bodies = theirs["bodies"].as_array().unwrap();
            assert_eq!(bodies.len(), node_bodies.len(), "{name}");
            for (ours, theirs) in bodies.iter().zip(node_bodies) {
                let label = ours["batchNumber"].as_str().unwrap();
                assert_eq!(*ours, untimed(theirs.clone(), label), "{name}");
            }
            assert_eq!(
                fingerprints_checked(serde_json::from_str(&captured).unwrap()),
                fingerprints_checked(theirs["captured"].clone()),
                "{name}"
            );
        }
        tx.rollback().await.unwrap();
    }

    /// The deletes in `.port-logs/batch-delete-cases.json` on the dev database, each in a savepoint
    /// rolled back after it, against Node's action over the same
    /// (`.port-logs/batch-delete-node.ts`): the answer, and what is left of batch 146 after it
    /// (`null` where the database's failure left the transaction unusable).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn deletes_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read_log("batch-delete-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("batch-delete.node.json")).unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = &case["name"];
            if case["method"] != "DELETE" {
                continue;
            }
            let mut each = tx.begin().await.unwrap();
            let answer = match batch_number(case["batch"].as_str().unwrap()) {
                Ok(batch) => deleted(&mut each, batch).await,
                Err(refused) => refused.into(),
            };
            let left: Option<Value> = sqlx::query_scalar(
                "SELECT json_build_object(
                     'batches', (SELECT count(*) FROM inventory_batches WHERE batch_number = 146)::int,
                     'items', (SELECT count(*) FROM inventory_batch_items WHERE batch_number = 146)::int)",
            )
            .fetch_one(&mut *each)
            .await
            .ok();
            each.rollback().await.unwrap();
            let answer = answer.into_response();
            let status = answer.status().as_u16();
            let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(u64::from(status), theirs["status"], "{name}");
            assert_eq!(body, theirs["body"], "{name}");
            // Node sent a number past an integer to the database, which failed the transaction;
            // here it is refused before, so batch 146 is still all there.
            let untouched = serde_json::json!({ "batches": 1, "items": 3 });
            let expected = match (&theirs["left"], status) {
                (Value::Null, 500) if case["batch"] == "2147483648" => &untouched,
                (left, _) => left,
            };
            assert_eq!(left.as_ref().unwrap_or(&Value::Null), expected, "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// Node's answers on the dev database's batches (`.port-logs/api-node.ts inventory-batches`),
    /// read only: the list, batches and their items, and every refusal before a write.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_routes_answer_as_node_answered() {
        for name in [
            "inventory-batches",
            "inventory-batch",
            "inventory-batch-items",
            "inventory-batch-results",
            "inventory-batch-publications",
        ] {
            crate::api::tests::answers_as_node(name, &[]).await;
        }
    }
}
