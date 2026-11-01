//! `POST /api/inventory-fifo`: an operator's FIFO actions for the default shipping seller, as the
//! Node route answered them. Reading an order's allocation, a line's revisions and the holds, and
//! one replay, are answered here; recording a disposition, superseding one and a quantity
//! correction still go to the Node app until they are ported.
use corten::{
    Api, JsonResponse, Prefix, Relay,
    axum::{
        body::{Body, to_bytes},
        extract::Request,
        http::StatusCode,
        response::IntoResponse,
    },
    prelude::*,
    upgrade::SwitchOr,
};
use serde_json::{Value, json};

use super::{operator, queue};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::shipping_configuration,
    legacy::{Legacy, forward},
};

/// The largest body read: an action and its evidence.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/inventory-fifo")]
pub struct InventoryFifo;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryFifo>(post(act).with_state(shared.clone()))
}

/// What an action asked for: an answer, or the request for the Node app.
enum Acted {
    Answer(Value),
    Node(Body),
}

/// The route's own answer, or the Node app's for an action it still answers. A handler answers
/// one type, so its own JSON goes out as a `Relay` too (corten#541).
async fn act(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    request: Request,
) -> corten::Result<SwitchOr<Relay>> {
    let (parts, body) = request.into_parts();
    let own = |answer: JsonResponse| {
        let (head, body) = answer.into_response().into_parts();
        Ok(SwitchOr::Answer(Relay::new(
            head.status,
            head.headers,
            body,
        )))
    };
    let body = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return own(api::error(StatusCode::CONFLICT, format!("Error: {error}"))),
    };
    match acted(&db, &body).await {
        Ok(Acted::Answer(answer)) => own(api::node_json(&answer)),
        Ok(Acted::Node(body)) => {
            forward(State(legacy), None, Request::from_parts(parts, body)).await
        }
        Err(Refused::Seller) => {
            let message = "Seller key must match the configured seller.";
            own(api::error(StatusCode::BAD_REQUEST, message))
        }
        Err(Refused::Failed(error)) => own(api::error(StatusCode::CONFLICT, error)),
    }
}

enum Refused {
    /// Not the configured seller: a 400.
    Seller,
    /// Anything else the Node route caught: a 409 with `String(error)`.
    Failed(String),
}

impl From<String> for Refused {
    fn from(message: String) -> Self {
        Refused::Failed(message)
    }
}

async fn acted(db: &Database, body: &[u8]) -> Result<Acted, Refused> {
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| Refused::Failed(format!("SyntaxError: {e}")))?;
    if payload.is_null() {
        return Err(Refused::Failed(
            "TypeError: Cannot read properties of null (reading 'sellerKey')".into(),
        ));
    }
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| Refused::Failed(format!("Error: {e}")))?;
    let configured = configured.trim();
    let seller = match payload.get("sellerKey").and_then(Value::as_str) {
        Some(named) => named.trim(),
        None => configured,
    };
    if seller.is_empty() || seller != configured {
        return Err(Refused::Seller);
    }
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
    let number = |key: &str| payload.get(key).and_then(Value::as_f64);
    let answer = match text("action") {
        Some("find_order") => {
            let order = text("orderNumber").filter(|o| !o.trim().is_empty());
            let order = order.ok_or_else(|| "Error: Order number is required.".to_owned())?;
            json!({ "lines": operator::order_allocation(db, seller, order).await? })
        }
        Some("list_holds") => {
            json!({ "holds": operator::holds(db, seller, number("afterSku"), number("limit")).await? })
        }
        Some("list_revisions") => {
            let line =
                text("lineId").ok_or_else(|| "Error: FIFO line ID is required.".to_owned())?;
            let (after, limit) = (number("afterRevision"), number("limit"));
            json!({ "revisions": operator::line_revisions(db, seller, line, after, limit).await? })
        }
        Some("replay") => json!({ "result": replayed(db, seller).await? }),
        Some("record_disposition" | "supersede_disposition" | "record_quantity_correction") => {
            return Ok(Acted::Node(Body::from(body.to_vec())));
        }
        _ => return Err("Error: Unknown inventory FIFO action.".to_owned().into()),
    };
    Ok(Acted::Answer(answer))
}

/// `processNextReplay` for the seller, as Node answers it.
async fn replayed(db: &Database, seller: &str) -> Result<Value, String> {
    let mut conn = db.0.acquire().await.map_err(|e| format!("Error: {e}"))?;
    let processed = queue::process_next(&mut conn, seller).await;
    Ok(match processed.map_err(|e| format!("Error: {e}"))? {
        None => Value::Null,
        Some(queue::Processed::Held { sku, reason }) => {
            json!({ "status": "held", "sellerKey": seller, "sku": sku, "reason": reason })
        }
        Some(queue::Processed::Complete { sku, changed_lines }) => {
            json!({ "status": "complete", "sellerKey": seller, "sku": sku, "changedLines": changed_lines })
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::{
        app::{Shared, app},
        database::Database,
        features::slab_connections,
        legacy::Legacy,
    };

    /// Node's answers on the dev database (`.port-logs/api-node.ts inventory-fifo`): an order's
    /// allocation, a line's revisions, the holds, and every refusal before them. A replay writes,
    /// so it is `queue::process_next`'s, compared with Node's in the shadow.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-fifo", &[]).await;
    }

    /// An action not ported yet goes to the Node app, whose absence is a 502 in its shape.
    #[tokio::test]
    async fn a_correction_still_goes_to_the_node_app() {
        crate::config::load_env();
        let router = app(Shared {
            db: Database::connect_lazy(&crate::config::database_url()),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .router();
        let request = corten::axum::http::Request::post("/api/inventory-fifo")
            .header("content-type", "application/json")
            .body(corten::axum::body::Body::from(
                r#"{"action":"record_quantity_correction"}"#,
            ))
            .unwrap();
        let answer = router.oneshot(request).await.unwrap();
        let status = answer.status();
        let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(status.is_server_error(), "{status} {body}");
        assert!(body["error"].is_string(), "{body}");
    }
}
