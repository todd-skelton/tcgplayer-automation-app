//! `POST /api/inventory-fifo`: an operator's FIFO actions for the default shipping seller, as the
//! Node route answered them: reading an order's allocation, a line's revisions and the holds, one
//! replay, and the corrections (`corrections`): recording a disposition, superseding one, and a
//! quantity correction, each in a transaction of its own.
use chrono::{DateTime, Utc};
use corten::{
    Api, JsonResponse, Prefix,
    axum::{body::to_bytes, extract::Request, http::StatusCode},
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    corrections::{self, Disposition, QuantityCorrection, Supersession},
    operator, queue,
};
use crate::{api, app::Shared, database::Database, features::shipping_configuration, node_pg};

/// The largest body read: an action and its evidence.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/inventory-fifo")]
pub struct InventoryFifo;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryFifo>(post(act).with_state(shared.clone()))
}

/// The action's answer, or Node's refusal.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let body = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return api::error(StatusCode::CONFLICT, format!("Error: {error}")),
    };
    match acted(&db, &body).await {
        Ok(answer) => api::node_json(&answer),
        Err(Refused::Seller) => {
            let message = "Seller key must match the configured seller.";
            api::error(StatusCode::BAD_REQUEST, message)
        }
        Err(Refused::Failed(error)) => api::error(StatusCode::CONFLICT, error),
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

async fn acted(db: &Database, body: &[u8]) -> Result<Value, Refused> {
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
        Some(
            action
            @ ("record_disposition" | "supersede_disposition" | "record_quantity_correction"),
        ) => {
            let correction = correction(action, &payload, seller)?;
            let mut tx = db.0.begin().await.map_err(node_pg::thrown)?;
            let result = correction.record(&mut tx).await?;
            tx.commit().await.map_err(node_pg::thrown)?;
            json!({ "result": result })
        }
        _ => return Err("Error: Unknown inventory FIFO action.".to_owned().into()),
    };
    Ok(answer)
}

/// A correction an action asks for, checked as Node's route checked it.
pub enum Correction {
    Disposition(Disposition),
    Supersession(Supersession),
    QuantityCorrection(QuantityCorrection),
}

impl Correction {
    /// Records it on `conn`, in the caller's transaction.
    pub async fn record(self, conn: &mut PgConnection) -> Result<Value, String> {
        match self {
            Correction::Disposition(input) => corrections::record_disposition(conn, input).await,
            Correction::Supersession(input) => {
                corrections::supersede_disposition(conn, input).await
            }
            Correction::QuantityCorrection(input) => {
                corrections::record_quantity_correction(conn, input).await
            }
        }
    }
}

/// `hasOffset`: a time written with `Z` or an offset that `Date.parse` reads, as `new Date` reads
/// it, to the millisecond.
fn offset_time(value: &Value) -> Option<DateTime<Utc>> {
    let text = value.as_str()?;
    let bytes = text.as_bytes();
    let offset = text.ends_with(['Z', 'z'])
        || (bytes.len() >= 6 && {
            let tail = &bytes[bytes.len() - 6..];
            matches!(tail[0], b'+' | b'-')
                && tail[1].is_ascii_digit()
                && tail[2].is_ascii_digit()
                && tail[3] == b':'
                && tail[4].is_ascii_digit()
                && tail[5].is_ascii_digit()
        });
    let at = DateTime::parse_from_rfc3339(text).ok().filter(|_| offset)?;
    DateTime::from_timestamp_millis(at.timestamp_millis())
}

/// The payload's `action` read into a correction for `seller`, or Node's refusal of it.
pub fn correction(action: &str, payload: &Value, seller: &str) -> Result<Correction, String> {
    let text = |key: &str| payload.get(key).and_then(Value::as_str).map(str::to_owned);
    let number = |key: &str| payload.get(key).and_then(Value::as_f64);
    let evidence = || payload.get("evidence").and_then(Value::as_object).cloned();
    let allocations = || {
        payload
            .get("sourceAllocations")
            .and_then(Value::as_array)
            .cloned()
    };
    let refused = |message: &str| format!("Error: {message}");
    match action {
        "record_disposition" => {
            let kind = text("dispositionType").filter(|kind| {
                matches!(
                    kind.as_str(),
                    "unfulfilled_cancellation" | "physical_restock"
                )
            });
            let (
                Some(request_id),
                Some(order_number),
                Some(sku_id),
                Some(disposition_type),
                Some(quantity),
                Some(revision),
                Some(available_at),
                Some(evidence),
                Some(source_allocations),
            ) = (
                text("requestId"),
                text("orderNumber"),
                text("skuId"),
                kind,
                number("quantity"),
                number("sourceOrderRevision"),
                payload.get("availableAt").and_then(offset_time),
                evidence(),
                allocations(),
            )
            else {
                return Err(refused(
                    "Complete disposition identity, quantity, availability, lineage, and evidence are required.",
                ));
            };
            Ok(Correction::Disposition(Disposition {
                request_id,
                seller_key: seller.to_owned(),
                order_number,
                sku_id,
                disposition_type,
                quantity,
                source_order_revision: revision,
                available_at,
                evidence,
                source_allocations,
            }))
        }
        "supersede_disposition" => {
            let (
                Some(request_id),
                Some(disposition_id),
                Some(revision),
                Some(confirmed_at),
                Some(evidence),
            ) = (
                text("requestId"),
                text("dispositionId"),
                number("sourceOrderRevision"),
                payload.get("confirmedAt").and_then(offset_time),
                evidence(),
            )
            else {
                return Err(refused(
                    "Complete correction identity and evidence are required.",
                ));
            };
            Ok(Correction::Supersession(Supersession {
                request_id,
                seller_key: seller.to_owned(),
                disposition_id,
                source_order_revision: revision,
                confirmed_at,
                evidence,
            }))
        }
        _ => {
            let (
                Some(request_id),
                Some(order_number),
                Some(sku_id),
                Some(revision),
                Some(available_at),
                Some(evidence),
                Some(source_allocations),
            ) = (
                text("requestId"),
                text("orderNumber"),
                text("skuId"),
                number("sourceOrderRevision"),
                payload.get("availableAt").and_then(offset_time),
                evidence(),
                allocations(),
            )
            else {
                return Err(refused(
                    "Complete quantity correction identity, time, source allocations, and evidence are required.",
                ));
            };
            Ok(Correction::QuantityCorrection(QuantityCorrection {
                request_id,
                seller_key: seller.to_owned(),
                order_number,
                sku_id,
                source_order_revision: revision,
                available_at,
                evidence,
                source_allocations,
            }))
        }
    }
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

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts inventory-fifo`): an order's
    /// allocation, a line's revisions, the holds, and every refusal before them. A replay writes,
    /// so it is `queue::process_next`'s, compared with Node's in the shadow.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-fifo", &[]).await;
    }
}
