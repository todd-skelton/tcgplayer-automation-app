//! `/api/seller-order-history`: how far the seller's order history reaches (`GET`), and a step of
//! its scan or an order export imported (`POST`), as the Node route answered them.
use corten::{
    Api, JsonResponse, Prefix,
    axum::{
        body::to_bytes,
        extract::{RawQuery, Request},
        http::StatusCode,
    },
    prelude::*,
};
use serde_json::{Value, json};

use super::{catch_up, coverage::coverage, file_import};
use crate::{api, app::Shared, database::Database, features::shipping_configuration};

/// The largest export an import takes, as the Node route measures it: the CSV's UTF-8 bytes.
const MAX_CSV_BYTES: usize = 5 * 1024 * 1024;
/// The largest body read: room for the largest export, escaped in JSON.
const MAX_BODY_BYTES: usize = 4 * MAX_CSV_BYTES;

#[derive(Route)]
#[route("/api/seller-order-history")]
pub struct SellerOrderHistory;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<SellerOrderHistory>(get(show).post(act).with_state(shared.clone()))
}

/// `resolveSellerKey`: the seller named, else the default shipping seller.
async fn seller(db: &Database, named: &str) -> Result<String, String> {
    if !named.trim().is_empty() {
        return Ok(named.trim().to_owned());
    }
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| format!("Error: {e}"))?;
    match configured.trim() {
        "" => Err("Error: A seller key is required.".to_owned()),
        configured => Ok(configured.to_owned()),
    }
}

/// The coverage of the seller named in `sellerKey`, else the default shipping seller's.
async fn show(State(db): State<Database>, RawQuery(query): RawQuery) -> JsonResponse {
    let named = api::first(query.as_deref(), "sellerKey").unwrap_or_default();
    let answer = async {
        let seller = seller(&db, &named).await?;
        coverage(&db, &seller)
            .await
            .map_err(|e| format!("Error: {e}"))
    };
    match answer.await {
        Ok(coverage) => api::node_json(&json!({ "coverage": coverage })),
        Err(error) => api::error(StatusCode::BAD_REQUEST, error),
    }
}

/// `catch_up` (a step of the scan, the `orderNumbers` asked about read first) or `import_csv`
/// (an order export, `csvText` named `fileName`), for the seller named in `sellerKey` else the
/// default shipping seller.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    match acted(&db, request).await {
        Ok(answer) => answer,
        Err(error) => api::error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

async fn acted(db: &Database, request: Request) -> Result<JsonResponse, String> {
    let body = to_bytes(request.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|e| format!("Error: {e}"))?;
    let payload: Value = serde_json::from_slice(&body).map_err(|e| format!("SyntaxError: {e}"))?;
    if payload.is_null() {
        return Err("TypeError: Cannot read properties of null (reading 'sellerKey')".into());
    }
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
    match text("action") {
        Some("catch_up") => {
            let orders: Vec<String> = payload
                .get("orderNumbers")
                .and_then(Value::as_array)
                .map(|numbers| numbers.iter().filter_map(|n| n.as_str().map(str::to_owned)))
                .into_iter()
                .flatten()
                .take(catch_up::PRIORITY)
                .collect();
            let named = seller(db, text("sellerKey").unwrap_or_default()).await?;
            let (seller, synced) = catch_up::requested(db, &named, &orders).await?;
            let coverage = coverage(db, &seller)
                .await
                .map_err(|e| format!("Error: {e}"))?;
            Ok(api::node_json(&json!({
                "coverage": coverage,
                "changedOrderNumbers": synced.changed,
            })))
        }
        Some("import_csv") => {
            let seller = seller(db, text("sellerKey").unwrap_or_default()).await?;
            let Some(csv) = text("csvText").filter(|t| !t.trim().is_empty()) else {
                let message = "A seller order CSV file is required.";
                return Ok(api::error(StatusCode::BAD_REQUEST, message));
            };
            if csv.len() > MAX_CSV_BYTES {
                let message = "Seller order CSV exceeds the 5 MB limit.";
                return Ok(api::error(StatusCode::PAYLOAD_TOO_LARGE, message));
            }
            let (seller, imported) = file_import::requested(db, &seller, text("fileName"), csv)
                .await
                .map_err(|e| format!("Error: {e}"))?;
            let coverage = coverage(db, &seller)
                .await
                .map_err(|e| format!("Error: {e}"))?;
            Ok(api::node_json(
                &json!({ "result": imported, "coverage": coverage }),
            ))
        }
        _ => {
            let _ = seller(db, text("sellerKey").unwrap_or_default()).await?;
            Ok(api::error(
                StatusCode::BAD_REQUEST,
                "Unknown seller order history action.",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts seller-order-history`): the
    /// coverage of the sellers asked about, and the posts it refuses before writing. A catch-up and
    /// an import are `catch_up`'s and `file_import`'s, tested against Node there.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("seller-order-history", &[]).await;
    }
}
