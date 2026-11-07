//! `POST /api/inventory-opening-balance`: an operator's opening balance actions for the configured
//! seller, as the Node route answered them. Its four pages (an observation's differences and
//! items, a run's application differences and preview items) are read here, a difference is
//! acknowledged here, an observation is previewed as a run here, and so are capturing an
//! observation and applying a run, which read the seller's inventory from Seller Portal and (to
//! apply) move the order history on (`capture`, `apply`).
use corten::{Api, JsonResponse, Prefix, extract::Request, http::StatusCode, prelude::*};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    acknowledgement::{self, Acknowledgement},
    apply::{self, Application, OrderHistory, TcgPlayerOrders},
    capture::{self, Capture, Portal, SellerPortal},
    pages, preview,
};
use crate::{
    api, app::Shared, database::Database, features::shipping_configuration, node_pg,
    tcgplayer::TcgPlayer,
};

/// The largest body read: an action and its IDs.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/inventory-opening-balance")]
pub struct InventoryOpeningBalance;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryOpeningBalance>(post(act).with_state(shared.clone()))
}

/// What reads TCGplayer for an action: Seller Portal for an observation, the order history's
/// scan before an application.
pub trait Live: Portal + OrderHistory {}

impl<T: Portal + OrderHistory> Live for T {}

/// TCGplayer itself.
struct Tcg<'a>(&'a TcgPlayer);

impl Portal for Tcg<'_> {
    async fn pricing_context(&self) -> Result<String, String> {
        SellerPortal(self.0).pricing_context().await
    }

    async fn export(&self) -> Result<String, String> {
        SellerPortal(self.0).export().await
    }
}

impl OrderHistory for Tcg<'_> {
    async fn catch_up(&self, conn: &mut PgConnection, seller: &str) -> Result<(), String> {
        TcgPlayerOrders(self.0).catch_up(conn, seller).await
    }
}

/// Why a request was refused: Node's status and message.
type Refused = (StatusCode, String);

/// The action's answer, or its refusal as Node's status and message.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let body = match crate::api::body_up_to(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return api::error(StatusCode::CONFLICT, format!("Error: {error}")),
    };
    let mut conn = match db.0.acquire().await {
        Ok(conn) => conn,
        Err(error) => return api::error(StatusCode::CONFLICT, node_pg::thrown(error)),
    };
    let tcgplayer = TcgPlayer::new(db.clone());
    match acted(&db, &mut conn, &body, &Tcg(&tcgplayer)).await {
        Ok(answer) => api::node_json(&answer),
        Err((status, message)) => api::error(status, message),
    }
}

/// The action `body` asks for, its pages read and its writes made on `conn`, for the seller
/// configured in `db`, TCGplayer read through `live`.
async fn acted(
    db: &Database,
    conn: &mut PgConnection,
    body: &[u8],
    live: &impl Live,
) -> Result<Value, Refused> {
    let failed = |message: String| (StatusCode::CONFLICT, message);
    let bad = |message: &str| (StatusCode::BAD_REQUEST, message.to_owned());
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| failed(format!("SyntaxError: {e}")))?;
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
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
        Some("capture") => {
            let request_id = text("requestId").ok_or_else(|| bad("Request ID is required."))?;
            let input = Capture {
                request_id,
                seller,
                purpose: None,
            };
            let observation = capture::capture(conn, live, &input, &capture::now_ms);
            json!({ "observation": observation.await.map_err(failed)? })
        }
        Some("apply") => {
            let (Some(request_id), Some(run_id), Some(evidence_fingerprint)) = (
                text("requestId"),
                text("runId"),
                text("evidenceFingerprint"),
            ) else {
                return Err(bad(
                    "Request ID, run ID, and evidence fingerprint are required.",
                ));
            };
            let input = Application {
                request_id,
                run_id,
                evidence_fingerprint,
                seller,
            };
            let result = apply::apply(conn, live, live, &input, &capture::now_ms);
            json!({ "result": result.await.map_err(failed)? })
        }
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
        Some("preview") => {
            let (Some(request_id), Some(observation_id)) =
                (text("requestId"), text("observationId"))
            else {
                return Err(bad("Request and observation IDs are required."));
            };
            let preview = preview::preview(conn, request_id, seller, observation_id);
            json!({ "preview": preview.await.map_err(failed)? })
        }
        Some("list_preview_items") => {
            let run = text("runId").ok_or_else(|| bad("Run ID is required."))?;
            let page =
                pages::preview_items(&mut *conn, seller, run, number("afterSku"), number("limit"));
            json!({ "items": page.await.map_err(failed)? })
        }
        _ => return Err(bad("Unknown opening balance action.")),
    };
    Ok(answer)
}

#[cfg(test)]
mod tests {

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts inventory-opening-balance`):
    /// each page as the dev seller's observations and run have them, and every refusal.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-opening-balance", &[]).await;
    }
}
