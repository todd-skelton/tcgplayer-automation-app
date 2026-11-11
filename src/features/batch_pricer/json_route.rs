//! `/api/inventory-batches`: the newest batches made by hand (`GET`), one batch (`GET` and
//! `DELETE /{batch}`), its items (`GET /{batch}/items?scope=`), its saved results
//! (`GET /{batch}/results?scope=`) and its pricing (`POST /{batch}/pricing-jobs`), as the Node
//! routes answered them, and so are making a batch from the counted inventory (`POST`) and from
//! a CSV export or a seller's live inventory (`POST /import-csv`, `POST /import-seller`). An
//! export is read up to 20 MB, as the screen's form reads it; Node read any size. A file input
//! left empty is no file ("CSV file is required"), where Node read a file with no name and no
//! rows. A batch's publications and preview (`GET /{batch}/publications`), planning its
//! publication (`POST`) and confirming an ambiguous item live (`PATCH`) are answered here too.
//! So is saving results priced in the browser (`POST /{batch}/results`, which no screen sends
//! now; `browser_results`).
//!
//! A batch's pricing stream (`GET /{batch}/pricing-stream`) is server-sent events of JSON: the
//! batch each time it changes, a heartbeat, and an error when there is no such batch. Corten
//! answers server-sent events only as live HTML patches (`corten::live`) or a feed's rows, so the
//! stream is a body of its own, sent as a `Relay`.
use std::{convert::Infallible, time::Duration};

use chrono::Utc;

use corten::{
    Api, JsonResponse, Prefix, Relay,
    extract::FromRequest,
    http::{Body, Request},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    prelude::*,
};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    batch_json, browser_results,
    import::{self, MOST_EXPORT_BYTES, NotImported},
};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{
        batch_pricing::queue,
        continuous_pricing::{
            refresh::{SellerInventory, TcgPlayerSearch},
            scheduler,
        },
        inventory_economics::ledger::fingerprint::js_json,
        inventory_intake::queue::{self as intake, NotQueued},
        inventory_publication::{
            confirmation::{self, NotConfirmed},
            plan, preview, publication_json,
        },
        shipping_configuration,
    },
    node_pg,
    tcgplayer::TcgPlayer,
};

#[derive(Route)]
#[route("/api/inventory-batches")]
pub struct InventoryBatches;

/// Static, so a batch's route does not take them for a batch.
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
    /// Every `scope` sent; Node read the first (`searchParams.get`).
    pub scope: Vec<String>,
}

#[derive(Route)]
#[route("/api/inventory-batches/{batch}/results")]
pub struct InventoryBatchResults<'a> {
    pub batch: &'a str,
    /// Every `scope` sent; Node read the first (`searchParams.get`).
    pub scope: Vec<String>,
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
    .route::<ImportCsv>(
        post(import_csv)
            .put(list_not_allowed)
            .patch(list_not_allowed)
            .delete(list_not_allowed)
            .with_state(shared.clone()),
    )
    .route::<ImportSeller>(
        post(import_seller)
            .put(list_not_allowed)
            .patch(list_not_allowed)
            .delete(list_not_allowed)
            .with_state(shared.clone()),
    )
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
            .post(save_results)
            .put(results_not_allowed)
            .patch(results_not_allowed)
            .delete(results_not_allowed)
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
            .patch(confirm)
            .put(publications_not_allowed)
            .delete(publications_not_allowed)
            .with_state(shared.clone()),
    )
}

/// The largest body of results priced in the browser read: a batch's priced SKUs.
const MAX_RESULTS_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Results priced in the browser, saved as the batch's (`browser_results`).
async fn save_results(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchResults<'_>>,
    request: Request,
) -> JsonResponse {
    let body = match crate::api::body_up_to(request.into_body(), MAX_RESULTS_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return failed(format!("Error: {error}")),
    };
    // A JavaScript `Date`, to the millisecond.
    let now = chrono::DateTime::from_timestamp_millis(Utc::now().timestamp_millis())
        .expect("now is in range");
    let saved = match db.0.acquire().await {
        Ok(mut conn) => results_saved(&mut conn, &at.batch, &body, now).await,
        Err(error) => Err((StatusCode::INTERNAL_SERVER_ERROR, node_pg::thrown(error))),
    };
    match saved {
        Ok(batch) => api::node_json(&batch),
        Err((status, message)) => api::error(status, message),
    }
}

/// The action on `conn`: the batch `raw` names, with `body`'s results saved at `now`, or Node's
/// status and message.
async fn results_saved(
    conn: &mut PgConnection,
    raw: &str,
    body: &[u8],
    now: chrono::DateTime<Utc>,
) -> Result<Value, (StatusCode, String)> {
    let batch = batch_number(raw).map_err(Refused::answer)?;
    let payload: Value = serde_json::from_slice(body).map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("SyntaxError: {error}"),
        )
    })?;
    browser_results::save_results(conn, batch, &payload, now)
        .await
        .map_err(|refused| match refused {
            browser_results::Refused::Bad(message) => (StatusCode::BAD_REQUEST, message.into()),
            browser_results::Refused::Thrown(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, message)
            }
        })
}

/// Any other write to a batch's results: Node's action, after the batch number.
async fn results_not_allowed(Params(at): Params<InventoryBatchResults<'_>>) -> JsonResponse {
    match batch_number(&at.batch) {
        Ok(_) => api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
        Err(refused) => refused.into(),
    }
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

impl Refused {
    /// Node's status and message.
    fn answer(self) -> (StatusCode, String) {
        match self {
            Refused::Invalid => (StatusCode::BAD_REQUEST, "Invalid batch number".into()),
            Refused::OutOfRange(n) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("error: value \"{n}\" is out of range for type integer"),
            ),
        }
    }
}

impl From<Refused> for JsonResponse {
    fn from(refused: Refused) -> Self {
        let (status, message) = refused.answer();
        api::error(status, message)
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
    let body = match crate::api::body_up_to(request.into_body(), MAX_CREATE_BODY_BYTES).await {
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
    let answer = batch_created(&mut tx, &body, api::js_trim(&seller)).await;
    finished(tx, answer).await
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

/// The first `file` of a multipart body, and its name, as `formData.get("file")` finds it; none
/// when that is text or missing. A body undici would not read as a form is Node's 500.
async fn exported_file(request: Request) -> Result<Option<(String, Vec<u8>)>, Box<JsonResponse>> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let essence = content_type.split(';').next().unwrap_or("").trim();
    if essence.eq_ignore_ascii_case("application/x-www-form-urlencoded") {
        // A form of text fields has no file.
        return Ok(None);
    }
    if !essence.eq_ignore_ascii_case("multipart/form-data") {
        return Err(Box::new(failed(
            "TypeError: Content-Type was not one of \"multipart/form-data\" or \"application/x-www-form-urlencoded\".",
        )));
    }
    let mut upload = Upload::<ExportForm>::from_request(request, &())
        .await
        .map_err(|_| Box::new(failed("TypeError: Failed to parse body as FormData.")))?;
    upload.limit(MOST_EXPORT_BYTES + (64 << 10));
    // A body that broke is Node's `formData()` error; a client that stopped sending (Corten's idle
    // time, a minute) is a 408, which Node, waiting on the body until its timeout, never said.
    let unread = |error: UploadError| match error {
        UploadError::Stalled => Box::new(api::error(StatusCode::REQUEST_TIMEOUT, error)),
        error => Box::new(failed(format!("TypeError: {error}"))),
    };
    while let Some(mut file) = upload.next_file().await.map_err(unread)? {
        if file.field() != "file" {
            continue;
        }
        let name = file.filename().to_owned();
        return match file.bytes_up_to(MOST_EXPORT_BYTES).await.map_err(unread)? {
            Some(bytes) => Ok(Some((name, bytes.to_vec()))),
            None => Err(Box::new(api::error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "A CSV export can be up to 20 MB.",
            ))),
        };
    }
    Ok(None)
}

/// The multipart body of an import: its `file`.
#[derive(Fields)]
struct ExportForm {
    #[allow(dead_code)]
    file: Files,
}

/// `POST /api/inventory-batches/import-csv`: the export as a batch queued for pricing in full.
async fn import_csv(State(db): State<Database>, request: Request) -> JsonResponse {
    let file = match exported_file(request).await {
        Ok(file) => file,
        Err(answer) => return *answer,
    };
    let Some((name, bytes)) = file else {
        return api::error(StatusCode::BAD_REQUEST, "CSV file is required");
    };
    let mut tx = match db.0.begin().await {
        Ok(tx) => tx,
        Err(error) => return failed(node_pg::thrown(error)),
    };
    let saved = import::save_csv(&mut tx, &name, &bytes).await;
    let answer = imported(&mut tx, saved).await;
    finished(tx, answer).await
}

/// `POST /api/inventory-batches/import-seller`: the seller's live inventory as a batch queued
/// for pricing in full.
async fn import_seller(State(db): State<Database>, request: Request) -> JsonResponse {
    let seller = match seller_key(request).await {
        Ok(seller) => seller,
        Err(answer) => return *answer,
    };
    let search = TcgPlayerSearch(TcgPlayer::new(db.clone()));
    let products = match search.products(&seller).await {
        Ok(products) => products,
        Err(error) => return failed(error),
    };
    let mut tx = match db.0.begin().await {
        Ok(tx) => tx,
        Err(error) => return failed(node_pg::thrown(error)),
    };
    let saved = import::save_seller(&mut tx, products, &seller).await;
    let answer = imported(&mut tx, saved).await;
    finished(tx, answer).await
}

/// The seller key of an import-seller body, `String(body.sellerKey ?? "").trim()`, or Node's
/// refusal of the body.
async fn seller_key(request: Request) -> Result<String, Box<JsonResponse>> {
    let body = crate::api::body_up_to(request.into_body(), MAX_CREATE_BODY_BYTES)
        .await
        .map_err(|error| Box::new(failed(format!("Error: {error}"))))?;
    seller_of(&body)
}

fn seller_of(body: &[u8]) -> Result<String, Box<JsonResponse>> {
    let body: Value = serde_json::from_slice(body)
        .map_err(|error| Box::new(failed(format!("SyntaxError: {error}"))))?;
    if body.is_null() {
        return Err(Box::new(failed(
            "TypeError: Cannot read properties of null (reading 'sellerKey')",
        )));
    }
    let seller = match body.get("sellerKey") {
        None | Some(Value::Null) => String::new(),
        Some(key) => api::js_trim(&api::js_string(key)).to_owned(),
    };
    if seller.is_empty() {
        return Err(Box::new(api::error(
            StatusCode::BAD_REQUEST,
            "Seller key is required",
        )));
    }
    Ok(seller)
}

/// An import's answer: the batch it queued, as `findByBatchNumber` reads it, with 201; or why
/// not, a 400 when there was nothing to import.
async fn imported(
    conn: &mut PgConnection,
    made: Result<i32, NotImported>,
) -> Result<JsonResponse, Box<JsonResponse>> {
    let batch = made.map_err(|not| {
        Box::new(match not {
            NotImported::Nothing(why) => api::error(StatusCode::BAD_REQUEST, why),
            NotImported::Failed(why) => failed(why),
        })
    })?;
    match batch_json::find(conn, batch).await {
        Ok(Some(found)) => Ok(api::node_json(&found).with_status(StatusCode::CREATED)),
        Ok(None) => Err(Box::new(not_found(batch))),
        Err(error) => Err(Box::new(failed(error))),
    }
}

/// The answer, with the transaction kept only when it is the batch.
async fn finished(
    tx: sqlx::Transaction<'_, sqlx::Postgres>,
    answer: Result<JsonResponse, Box<JsonResponse>>,
) -> JsonResponse {
    match answer {
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
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let errors = at.scope.first().map(String::as_str) == Some("errors");
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
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let manual_review = at.scope.first().map(String::as_str) == Some("manual-review");
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
    let body = match crate::api::body_up_to(request.into_body(), MAX_PRICING_BODY_BYTES).await {
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
    let body = match crate::api::body_up_to(request.into_body(), MAX_PUBLISH_BODY_BYTES).await {
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

/// The largest confirmation read: ids, a time and the evidence.
const MAX_CONFIRM_BODY_BYTES: usize = 64 * 1024;

/// `PATCH`: an ambiguous item confirmed live, in a transaction kept only when it is answered.
async fn confirm(
    State(db): State<Database>,
    Params(at): Params<InventoryBatchPublications<'_>>,
    request: Request,
) -> JsonResponse {
    let batch = match batch_number(&at.batch) {
        Ok(batch) => batch,
        Err(refused) => return refused.into(),
    };
    let body = match crate::api::body_up_to(request.into_body(), MAX_CONFIRM_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return failed(format!("Error: {error}")),
    };
    let mut tx = match db.0.begin().await {
        Ok(tx) => tx,
        Err(error) => return failed(node_pg::thrown(error)),
    };
    let answer = confirmed(&mut tx, batch, &body, Utc::now()).await;
    finished(tx, answer).await
}

/// The publication once the body's confirmation is saved, or Node's refusal of it.
async fn confirmed(
    conn: &mut PgConnection,
    batch: i32,
    body: &[u8],
    now: chrono::DateTime<Utc>,
) -> Result<JsonResponse, Box<JsonResponse>> {
    let body: Value = serde_json::from_slice(body)
        .map_err(|error| Box::new(failed(format!("SyntaxError: {error}"))))?;
    if body.is_null() {
        return Err(Box::new(failed(
            "TypeError: Cannot read properties of null (reading 'publicationId')",
        )));
    }
    let refused = |not: NotConfirmed| {
        let status = match not {
            NotConfirmed::Invalid => StatusCode::BAD_REQUEST,
            NotConfirmed::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::CONFLICT,
        };
        Box::new(api::error(status, not.message()))
    };
    let confirmation = confirmation::read(&body, now).map_err(refused)?;
    let id = confirmation::confirm(conn, batch, &confirmation)
        .await
        .map_err(refused)?;
    let publications = publication_json::by_ids(conn, &[id])
        .await
        .map_err(|error| Box::new(failed(error)))?;
    Ok(api::node_json(&publications[0]))
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

    /// Node's answers on the dev database's batches (`scripts/parity/record-node-answers.ts inventory-batches`),
    /// read only: the list, batches and their items, and every refusal before a write.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
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
