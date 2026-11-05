//! `/api/inventory-intake-runs`: the latest queued batches and the seller they are for (`GET`),
//! and the counts queued as a batch from a JSON request (`POST`), as the Node route answered
//! them. The form at `/inventory-manager/queue` queues through the same [`queue::queue`].
//!
//! Node's route also started its pricing and publication workers in its own process; this one
//! cannot (see `queue`). A write from another site is refused by Corten before the route reads
//! it, with its own message ("Cross-site request refused."), where Node said "Queue requests
//! require same-site JSON."; and Corten also refuses one from a sibling site (`Sec-Fetch-Site:
//! same-site`), which Node took.
use corten::{
    Api, JsonResponse, Prefix, Refusal,
    axum::{body::to_bytes, extract::Request},
    http::{StatusCode, header},
    prelude::*,
};
use serde_json::{Map, Value, json};

use super::queue::{self, IntakeQuantity, NotQueued, Queue, Workflow};
use crate::{
    api::{self, js_trim},
    app::Shared,
    database::Database,
    features::batch_pricer::batch_json,
};

/// The most a request may be: 256,000 UTF-16 units, which no body of more bytes than three
/// times that can be.
const MAX_UNITS: usize = 256_000;

const INVALID: &str = "A request ID and valid queue options are required.";

#[derive(Route)]
#[route("/api/inventory-intake-runs")]
pub struct InventoryIntakeRuns;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryIntakeRuns>(get(show).post(act).with_state(shared.clone()))
}

/// The 25 newest runs and the publication target.
async fn show(State(db): State<Database>) -> JsonResponse {
    let read = async {
        let runs = queue::runs_json(&db.0).await?;
        let target = queue::target(&db).await?;
        Ok::<_, sqlx::Error>(json!({ "runs": runs, "target": target }))
    };
    match read.await {
        Ok(answer) => api::node_json(&answer),
        Err(error) => api::error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

/// The request as Node checked it before queuing: what queuing does, the counts and the seller
/// the screen showed, and an entered cost (an object, if sent).
struct Asked {
    request_id: String,
    workflow: Workflow,
    expected: Vec<IntakeQuantity>,
    seller_key: String,
    purchase_cost: Option<Map<String, Value>>,
    estimated_cost_rate: Option<Map<String, Value>>,
}

/// `Number.isSafeInteger` of a positive JSON number.
fn positive_whole(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && number > 0.0 && number <= 9_007_199_254_740_991.0)
        .then_some(number as i64)
}

/// `isIntakeSnapshot`: 1 to 5,000 distinct SKUs, each with a positive whole count.
fn snapshot(value: &Value) -> Option<Vec<IntakeQuantity>> {
    let items = value.as_array()?;
    if items.is_empty() || items.len() > 5000 {
        return None;
    }
    let counts = items
        .iter()
        .map(|item| {
            Some(IntakeQuantity {
                sku: positive_whole(item.get("sku")?)?,
                quantity: positive_whole(item.get("quantity")?)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let mut skus: Vec<i64> = counts.iter().map(|c| c.sku).collect();
    skus.sort_unstable();
    skus.dedup();
    (skus.len() == counts.len()).then_some(counts)
}

/// An entered cost: absent, or an object that is not an array; anything else is refused.
fn cost_fields(value: Option<&Value>, keys: &[&str]) -> Result<Option<Map<String, Value>>, ()> {
    match value {
        None => Ok(None),
        Some(Value::Object(fields)) => Ok(Some(
            keys.iter()
                .filter_map(|key| Some((key.to_string(), fields.get(*key)?.clone())))
                .collect(),
        )),
        Some(_) => Err(()),
    }
}

/// The request, or `None` where Node answered `INVALID`.
fn asked(body: &Value) -> Option<Asked> {
    let request_id = body.get("requestId")?.as_str()?;
    if js_trim(request_id).is_empty() || request_id.encode_utf16().count() > 180 {
        return None;
    }
    let workflow = match body.get("workflow")?.as_str()? {
        "price_only" => Workflow::PriceOnly,
        "publish" => Workflow::Publish,
        _ => return None,
    };
    let expected = snapshot(body.get("expectedInventory")?)?;
    let seller_key = body.get("expectedSellerKey")?.as_str()?;
    if seller_key.encode_utf16().count() > 200 {
        return None;
    }
    let purchase_cost = cost_fields(
        body.get("purchaseCost"),
        &[
            "purchaseReference",
            "totalAmount",
            "provenance",
            "allocationRule",
            "currency",
            "purchasedAt",
        ],
    )
    .ok()?;
    let estimated_cost_rate = cost_fields(
        body.get("estimatedCostRate"),
        &["marketPercent", "perCardDeduction"],
    )
    .ok()?;
    Some(Asked {
        request_id: js_trim(request_id).to_owned(),
        workflow,
        expected,
        seller_key: seller_key.to_owned(),
        purchase_cost,
        estimated_cost_rate,
    })
}

/// The counts queued as a batch: `201` with the batch, or why not.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let (parts, body) = request.into_parts();
    let json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|t| t.split(';').next())
        .is_some_and(|t| js_trim(t).eq_ignore_ascii_case("application/json"));
    if !json {
        return api::error(
            StatusCode::FORBIDDEN,
            "Queue requests require same-site JSON.",
        );
    }
    let too_large = || api::error(StatusCode::PAYLOAD_TOO_LARGE, "Queue request is too large.");
    let Ok(bytes) = to_bytes(body, MAX_UNITS * 3).await else {
        return too_large();
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.encode_utf16().count() > MAX_UNITS {
        return too_large();
    }
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let Some(asked) = asked(&body) else {
        return api::error(StatusCode::BAD_REQUEST, INVALID);
    };
    let request = Queue {
        workflow: asked.workflow,
        purchase_cost: asked.purchase_cost,
        estimated_cost_rate: asked.estimated_cost_rate,
        expected: &asked.expected,
        seller_key: &asked.seller_key,
    };
    let queued = match queue::queue(&db, &asked.request_id, &request).await {
        Ok(queued) => queued,
        Err(NotQueued::Refused(Refusal::Conflict, message)) => {
            return api::error(StatusCode::CONFLICT, message);
        }
        Err(NotQueued::Refused(_, message)) => {
            return api::error(StatusCode::BAD_REQUEST, message);
        }
        Err(NotQueued::Unrecorded(message) | NotQueued::Failed(message)) => {
            return api::error(StatusCode::INTERNAL_SERVER_ERROR, message);
        }
    };
    let batch = match db.0.acquire().await {
        Ok(mut conn) => batch_json::find(&mut conn, queued.batch_number).await,
        Err(error) => Err(error.to_string()),
    };
    match batch {
        Ok(batch) => api::node_json(&batch).with_status(StatusCode::CREATED),
        Err(message) => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

#[cfg(test)]
mod tests {
    /// Each request Node's route was asked (`scripts/parity/record-node-answers.ts inventory-intake-runs`) gets
    /// the status and JSON it gave, on the dev database, which has no counts: a well-formed
    /// request is refused as counts that moved, so none writes. A queued batch's JSON is checked
    /// against Node's in `queue::tests::queues_as_node_queues`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        use sqlx::Connection;
        // The tests that queue against seeded counts hold this lock while their counts exist;
        // held here, they wait, and a request here never waits on their queue lock.
        crate::config::load_env();
        let mut held = sqlx::PgConnection::connect(&crate::config::database_url())
            .await
            .unwrap();
        sqlx::query("SELECT pg_advisory_lock(hashtext('inventory_batch_pricing_jobs tests'))")
            .execute(&mut held)
            .await
            .unwrap();
        crate::api::tests::answers_as_node("inventory-intake-runs", &[]).await;
        held.close().await.unwrap();
    }
}
