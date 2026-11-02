//! `POST /api/inventory-opening-balance`: an operator's opening balance actions for the configured
//! seller, as the Node route answered them. Its four pages (an observation's differences and
//! items, a run's application differences and preview items) are read here, and a difference is
//! acknowledged here. Capturing an observation and previewing and applying a run still go to the
//! Node app: capture and apply read the seller's inventory from TCGplayer.
use corten::{
    Api, JsonError, JsonResponse, Prefix,
    axum::{
        body::{Body, to_bytes},
        extract::Request,
        http::StatusCode,
    },
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    acknowledgement::{self, Acknowledgement},
    pages,
};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::shipping_configuration,
    legacy::{Legacy, relay_request},
    node_pg,
};

/// The largest body read: an action and its IDs.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The actions still answered by the Node app.
const RELAYED: [&str; 3] = ["capture", "preview", "apply"];

#[derive(Route)]
#[route("/api/inventory-opening-balance")]
pub struct InventoryOpeningBalance;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryOpeningBalance>(post(act).with_state(shared.clone()))
}

/// What an action asked for: an answer, or the request for the Node app.
enum Acted {
    Answer(Value),
    Node,
}

/// Why a request was refused: Node's status and message.
type Refused = (StatusCode, String);

/// The route's own answer, or the Node app's for an action it still answers, passed on as it came.
async fn act(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    request: Request,
) -> Result<JsonResponse, JsonError> {
    let (parts, body) = request.into_parts();
    let own = Ok;
    let body = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return own(api::error(StatusCode::CONFLICT, format!("Error: {error}"))),
    };
    if relayed(&body) {
        return send_on(&legacy, parts, body).await;
    }
    let mut conn = match db.0.acquire().await {
        Ok(conn) => conn,
        Err(error) => return own(api::error(StatusCode::CONFLICT, node_pg::thrown(error))),
    };
    match acted(&db, &mut conn, &body).await {
        Ok(Acted::Answer(answer)) => own(api::node_json(&answer)),
        Ok(Acted::Node) => send_on(&legacy, parts, body).await,
        Err((status, message)) => own(api::error(status, message)),
    }
}

/// The request passed on to the Node app, its answer as it came.
async fn send_on(
    legacy: &Legacy,
    parts: corten::axum::http::request::Parts,
    body: corten::axum::body::Bytes,
) -> Result<JsonResponse, JsonError> {
    Ok(
        relay_request(legacy, Request::from_parts(parts, Body::from(body)))
            .await?
            .into(),
    )
}

/// Whether the body asks for an action the Node app still answers, which needs no database here.
fn relayed(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body).is_ok_and(|payload| {
        payload
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|action| RELAYED.contains(&action))
    })
}

/// The action `body` asks for, its pages read and its writes made on `conn`, for the seller
/// configured in `db`.
async fn acted(db: &Database, conn: &mut PgConnection, body: &[u8]) -> Result<Acted, Refused> {
    let failed = |message: String| (StatusCode::CONFLICT, message);
    let bad = |message: &str| (StatusCode::BAD_REQUEST, message.to_owned());
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| failed(format!("SyntaxError: {e}")))?;
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
    if text("action").is_some_and(|action| RELAYED.contains(&action)) {
        return Ok(Acted::Node);
    }
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| failed(format!("Error: {e}")))?;
    if payload.is_null() {
        let message = "TypeError: Cannot read properties of null (reading 'sellerKey')";
        return Err(failed(message.into()));
    }
    let configured = api::js_trim(&configured);
    let seller = text("sellerKey").map_or(configured, api::js_trim);
    if seller.is_empty() || seller != configured {
        return Err(bad("Seller key must match the configured seller."));
    }
    let number = |key: &str| payload.get(key).and_then(Value::as_f64);
    let answer = match text("action") {
        Some("list_differences") => {
            let observation =
                text("observationId").ok_or_else(|| bad("Observation ID is required."))?;
            let page = pages::differences(
                &mut *conn,
                seller,
                observation,
                text("afterId"),
                number("limit"),
            );
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_application_differences") => {
            let (Some(run), Some(validation)) = (text("runId"), text("validationObservationId"))
            else {
                return Err(bad("Run and validation observation IDs are required."));
            };
            let (after, limit) = (text("afterId"), number("limit"));
            let page =
                pages::application_differences(&mut *conn, seller, run, validation, after, limit);
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_observation_items") => {
            let observation =
                text("observationId").ok_or_else(|| bad("Observation ID is required."))?;
            let (after, limit) = (text("afterInventoryKey"), number("limit"));
            let unsupported_only = payload.get("unsupportedOnly").and_then(Value::as_bool);
            let page = pages::observation_items(
                &mut *conn,
                seller,
                observation,
                after,
                limit,
                unsupported_only,
            );
            json!({ "items": page.await.map_err(failed)? })
        }
        Some("acknowledge_difference") => {
            let (Some(request_id), Some(difference_id), Some(note)) =
                (text("requestId"), text("differenceId"), text("note"))
            else {
                return Err(bad(
                    "Request ID, difference ID, and acknowledgement note are required.",
                ));
            };
            let input = Acknowledgement {
                request_id,
                difference_id,
                seller,
                note,
            };
            json!({ "result": acknowledgement::acknowledge(conn, &input).await.map_err(failed)? })
        }
        Some("list_preview_items") => {
            let run = text("runId").ok_or_else(|| bad("Run ID is required."))?;
            let page =
                pages::preview_items(&mut *conn, seller, run, number("afterSku"), number("limit"));
            json!({ "items": page.await.map_err(failed)? })
        }
        _ => return Err(bad("Unknown opening balance action.")),
    };
    Ok(Acted::Answer(answer))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use sqlx::Connection;

    use super::{Acted, acted};
    use crate::database::Database;

    /// The acknowledgements in `.port-logs/opening-ack-cases.json` from its seeded differences, on
    /// the dev database in a transaction rolled back (a savepoint each), against Node's action
    /// over the same (`.port-logs/opening-ack-node.ts`): each answer and the differences left.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn acknowledgements_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let recorded: Value = serde_json::from_str(&read_log("opening-ack-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("opening-ack.node.json")).unwrap();
        let capture = read_log("opening-ack-capture.sql");
        let cases = recorded["cases"].as_array().unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(recorded["seed"].as_str().unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let mut each = tx.begin().await.unwrap();
            let mut answers = Vec::new();
            for body in case["steps"].as_array().unwrap() {
                let body = body.as_str().unwrap().as_bytes();
                answers.push(match acted(&db, &mut each, body).await {
                    Ok(Acted::Answer(answer)) => {
                        serde_json::json!({ "status": 200, "body": answer })
                    }
                    Ok(Acted::Node) => panic!("{name}: sent to the Node app"),
                    Err((status, error)) => serde_json::json!({
                        "status": status.as_u16(),
                        "body": { "error": error },
                    }),
                });
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(Value::from(answers), theirs["answers"], "{name}");
            let captured: Value = serde_json::from_str(&captured).unwrap();
            assert_eq!(captured, theirs["captured"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// Node's answers on the dev database (`.port-logs/api-node.ts inventory-opening-balance`):
    /// each page as the dev seller's observations and run have them, and every refusal.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-opening-balance", &[]).await;
    }

    /// Capturing, previewing and applying are the Node app's to answer, even for another seller
    /// and with no database, so each is passed on: here to a Node app that is not there.
    #[tokio::test]
    async fn the_writes_still_go_to_the_node_app() {
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
            r#"{"action":"capture","requestId":"r"}"#,
            r#"{"action":"preview"}"#,
            r#"{"action":"apply","sellerKey":"someone-else"}"#,
        ] {
            let post = Request::post("/api/inventory-opening-balance")
                .header("host", "localhost")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let answer = router.clone().oneshot(post).await.unwrap();
            assert_eq!(answer.status(), 502, "{body}");
        }
    }
}
