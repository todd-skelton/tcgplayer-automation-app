//! `/api/inventory-economics`: the default shipping seller's economics workspace (`GET`), and the
//! operator's estimate actions (`POST`) as the Node route answered them: `record_estimated_purchase_costs`
//! (the backfill) and `change_estimated_cost_rate`. Its other actions (recording a purchase cost,
//! funding or an expense, finding allocation targets, importing a CSV), and a body that is not a
//! JSON object naming one of the two, still go to the Node app.
use corten::{
    Api, JsonError, JsonResponse, Prefix,
    axum::{
        body::{Body, to_bytes},
        extract::Request,
        http::StatusCode,
    },
    prelude::*,
};
use serde_json::{Map, Value, json};

use super::{estimate, ledger::fingerprint::js_float, workspace_json};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{inventory_intake::queue::cost_rate, shipping_configuration},
    legacy::{Legacy, relay_request},
};

/// The largest body read before it is answered or relayed.
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

const NO_SELLER: &str = "Configure a default shipping seller before recording inventory economics.";

#[derive(Route)]
#[route("/api/inventory-economics")]
pub struct EconomicsApi;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<EconomicsApi>(get(show).post(act).with_state(shared.clone()))
}

/// `configuredSeller`: the default shipping seller, or why there is none.
async fn seller(db: &Database) -> Result<String, String> {
    let seller = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| e.to_string())?;
    let seller = seller.trim();
    if seller.is_empty() {
        return Err(NO_SELLER.to_owned());
    }
    Ok(seller.to_owned())
}

/// The workspace; a 500 saying why when it cannot be read.
async fn show(State(db): State<Database>) -> JsonResponse {
    let workspace = match seller(&db).await {
        Ok(seller) => workspace_json::read(&db, &seller).await,
        Err(message) => Err(message),
    };
    match workspace {
        Ok(workspace) => api::node_json(&json!({ "workspace": workspace })),
        Err(message) => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

/// An estimate action answered here, or the Node app's answer to the request, passed on as it came.
async fn act(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    request: Request,
) -> Result<JsonResponse, JsonError> {
    let own = Ok;
    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, MAX_BODY_BYTES).await else {
        return own(api::error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Request body is too large.",
        ));
    };
    let payload = serde_json::from_slice::<Value>(&bytes).ok();
    let ours = payload.as_ref().and_then(Value::as_object).filter(|p| {
        matches!(
            p.get("action").and_then(Value::as_str),
            Some("record_estimated_purchase_costs" | "change_estimated_cost_rate")
        )
    });
    let Some(payload) = ours else {
        return Ok(
            relay_request(&legacy, Request::from_parts(parts, Body::from(bytes)))
                .await?
                .into(),
        );
    };
    // Node's action answers every failure with a 409 saying why.
    match estimated(&db, payload).await {
        Ok(answer) => own(api::node_json(&answer)),
        Err(message) => own(api::error(StatusCode::CONFLICT, message)),
    }
}

/// The action's answer: the run, and for the backfill the workspace after it.
async fn estimated(db: &Database, payload: &Map<String, Value>) -> Result<Value, String> {
    let seller = seller(db).await?;
    if payload.get("action").and_then(Value::as_str) == Some("record_estimated_purchase_costs") {
        let batches: Option<Vec<i32>> = payload
            .get("batchNumbers")
            .map(|value| batch_numbers(value)?.into_iter().map(integer).collect())
            .transpose()?;
        let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
        let run = estimate::record_estimates(&mut conn, &seller, batches.as_deref())
            .await
            .map_err(String::from)?;
        drop(conn);
        let workspace = workspace_json::read(db, &seller).await?;
        return Ok(json!({ "result": run.node_json(), "workspace": workspace }));
    }
    // A batch number left out is `String(undefined)`, which is not a number either.
    let batch = payload
        .get("batchNumber")
        .cloned()
        .unwrap_or_else(|| "undefined".into());
    let [batch] = batch_numbers(&Value::Array(vec![batch]))?[..] else {
        unreachable!("one value is one batch number");
    };
    let rate = cost_rate(payload)?;
    let run = estimate::change_rate(db, integer(batch)?, rate).await?;
    Ok(json!({ "result": run.node_json() }))
}

/// JavaScript's `String(value)` of a JSON value.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(n) => js_float(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        // `join` writes null as nothing.
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// A batch number as Postgres's `integer`, or refused as Postgres refused it in Node's query.
fn integer(n: f64) -> Result<i32, String> {
    if n > f64::from(i32::MAX) {
        Err(format!(
            "value \"{}\" is out of range for type integer",
            js_float(n)
        ))
    } else {
        Ok(n as i32)
    }
}

/// `parseBatchNumbers`: a list, or text split at `|`, `;` or `,`, of positive whole numbers.
fn batch_numbers(value: &Value) -> Result<Vec<f64>, String> {
    let values: Vec<String> = match value {
        Value::Array(items) => items.iter().map(js_string).collect(),
        Value::String(text) => text.split(['|', ';', ',']).map(str::to_owned).collect(),
        _ => Vec::new(),
    };
    let numbers: Vec<f64> = values
        .iter()
        .map(|text| api::js_number(api::js_trim(text)).unwrap_or(f64::NAN))
        .collect();
    if numbers.is_empty()
        || numbers
            .iter()
            .any(|n| !n.is_finite() || n.fract() != 0.0 || *n <= 0.0)
    {
        return Err("Batch numbers must be positive integers.".to_owned());
    }
    Ok(numbers)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{batch_numbers, integer};

    #[test]
    fn batch_numbers_are_read_as_node_reads_them() {
        assert_eq!(
            batch_numbers(&json!("206; 2733|672")),
            Ok(vec![206.0, 2733.0, 672.0])
        );
        assert_eq!(
            batch_numbers(&json!([206, "0x10", [5], 7.0])),
            Ok(vec![206.0, 16.0, 5.0, 7.0])
        );
        let refused = Err("Batch numbers must be positive integers.".to_owned());
        for value in [
            json!([]),
            json!(""),
            json!([0]),
            json!([1.5]),
            json!([null]),
            json!(5),
            json!([true]),
            json!([{}]),
            json!("1,,2"),
        ] {
            assert_eq!(batch_numbers(&value), refused, "{value}");
        }
        assert_eq!(integer(2_147_483_647.0), Ok(i32::MAX));
        assert_eq!(
            integer(3e9),
            Err("value \"3000000000\" is out of range for type integer".to_owned())
        );
    }

    /// An action not ported goes to the Node app before anything is read, so its absence is a
    /// 502 in Node's error shape.
    #[tokio::test]
    async fn other_actions_still_go_to_the_node_app() {
        use corten::axum::{body::Body, http::Request};
        use tower::ServiceExt;

        use crate::{database::Database, features::slab_connections, legacy::Legacy};

        let router = crate::app::app(crate::app::Shared {
            db: Database::connect_lazy("postgresql://localhost:1/unused"),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .router();
        for body in [
            r#"{"action":"record_funding"}"#,
            "{",
            "null",
            r#"{"action":7}"#,
        ] {
            let post = Request::post("/api/inventory-economics")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let answer = router.clone().oneshot(post).await.unwrap();
            assert_eq!(answer.status(), 502, "{body}");
            let bytes = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
                .await
                .unwrap();
            let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert!(json["error"].is_string(), "{body}: {json}");
        }
    }

    /// Node's answers on the dev database (`.port-logs/api-node.ts inventory-economics`): the
    /// workspace, and each estimate action's refusals before it writes. What a backfill or a rate
    /// change writes is compared with Node's in `estimate::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-economics", &["/workspace/generatedAt"])
            .await;
    }
}
