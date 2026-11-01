//! `/api/inventory-batches`: the newest batches made by hand (`GET`), one batch (`GET` and
//! `DELETE /{batch}`) and its items (`GET /{batch}/items?scope=`), as the Node routes answered
//! them. Making a batch from the counted inventory (`POST`), and making one from a CSV or a
//! seller (`/import-csv`, `/import-seller`), still go to the Node app; so do a batch's results,
//! publications, pricing jobs and pricing stream, under the relay for every path not ported.
use corten::{
    Api, JsonError, JsonResponse, Prefix,
    axum::{
        extract::{RawQuery, Request},
        http::StatusCode,
    },
    prelude::*,
};
use serde_json::json;
use sqlx::PgConnection;

use super::batch_json;
use crate::{
    api,
    app::Shared,
    database::Database,
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

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryBatches>(get(list).post(relay).with_state(shared.clone()))
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

#[cfg(test)]
mod tests {
    use corten::axum::response::IntoResponse;
    use serde_json::Value;
    use sqlx::Connection;

    use super::*;

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
        ] {
            crate::api::tests::answers_as_node(name, &[]).await;
        }
    }
}
