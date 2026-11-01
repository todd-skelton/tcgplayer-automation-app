//! `POST /api/inventory-opening-balance`: an operator's opening balance actions for the configured
//! seller, as the Node route answered them. Its four pages (an observation's differences and
//! items, a run's application differences and preview items) are read here. Capturing an
//! observation, previewing and applying a run, and acknowledging a difference still go to the Node
//! app: capture and apply read the seller's inventory from TCGplayer.
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

use super::pages;
use crate::{
    api,
    app::Shared,
    database::Database,
    features::shipping_configuration,
    legacy::{Legacy, relay_request},
};

/// The largest body read: an action and its IDs.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The actions still answered by the Node app.
const RELAYED: [&str; 4] = ["capture", "preview", "apply", "acknowledge_difference"];

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
    match acted(&db, &body).await {
        Ok(Acted::Answer(answer)) => own(api::node_json(&answer)),
        Ok(Acted::Node) => Ok(
            relay_request(&legacy, Request::from_parts(parts, Body::from(body)))
                .await?
                .into(),
        ),
        Err((status, message)) => own(api::error(status, message)),
    }
}

async fn acted(db: &Database, body: &[u8]) -> Result<Acted, Refused> {
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
            let page =
                pages::differences(&db.0, seller, observation, text("afterId"), number("limit"));
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_application_differences") => {
            let (Some(run), Some(validation)) = (text("runId"), text("validationObservationId"))
            else {
                return Err(bad("Run and validation observation IDs are required."));
            };
            let (after, limit) = (text("afterId"), number("limit"));
            let page = pages::application_differences(&db.0, seller, run, validation, after, limit);
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_observation_items") => {
            let observation =
                text("observationId").ok_or_else(|| bad("Observation ID is required."))?;
            let (after, limit) = (text("afterInventoryKey"), number("limit"));
            let unsupported_only = payload.get("unsupportedOnly").and_then(Value::as_bool);
            let page = pages::observation_items(
                &db.0,
                seller,
                observation,
                after,
                limit,
                unsupported_only,
            );
            json!({ "items": page.await.map_err(failed)? })
        }
        Some("list_preview_items") => {
            let run = text("runId").ok_or_else(|| bad("Run ID is required."))?;
            let page =
                pages::preview_items(&db.0, seller, run, number("afterSku"), number("limit"));
            json!({ "items": page.await.map_err(failed)? })
        }
        _ => return Err(bad("Unknown opening balance action.")),
    };
    Ok(Acted::Answer(answer))
}

#[cfg(test)]
mod tests {
    /// Node's answers on the dev database (`.port-logs/api-node.ts inventory-opening-balance`):
    /// each page as the dev seller's observations and run have them, and every refusal.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-opening-balance", &[]).await;
    }

    /// Capturing, previewing, applying and acknowledging are the Node app's to answer, even for
    /// another seller, so each is passed on: here to a Node app that is not there.
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
            r#"{"action":"acknowledge_difference"}"#,
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
