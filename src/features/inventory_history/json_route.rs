//! `GET /api/inventory-history-diagnostics`: the default shipping seller's inventory history
//! diagnostics, as the Node route answered them.
use corten::{Api, JsonResponse, Prefix, axum::http::StatusCode, prelude::*};
use serde_json::json;

use super::diagnostics::diagnostics;
use crate::{api, app::Shared, database::Database, features::shipping_configuration};

#[derive(Route)]
#[route("/api/inventory-history-diagnostics")]
pub struct InventoryHistoryDiagnostics;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryHistoryDiagnostics>(get(show).with_state(shared.clone()))
}

/// The diagnostics; a 409 while no default shipping seller is set.
async fn show(State(db): State<Database>) -> JsonResponse {
    let seller = match shipping_configuration::default_seller_key(&db).await {
        Ok(seller) => seller.trim().to_owned(),
        Err(error) => {
            return api::error(StatusCode::INTERNAL_SERVER_ERROR, format!("Error: {error}"));
        }
    };
    if seller.is_empty() {
        return api::error(
            StatusCode::CONFLICT,
            "A default shipping seller is required.",
        );
    }
    match diagnostics(&db, &seller).await {
        Ok(diagnostics) => api::node_json(&json!({ "diagnostics": diagnostics })),
        Err(error) => api::error(StatusCode::INTERNAL_SERVER_ERROR, format!("Error: {error}")),
    }
}

#[cfg(test)]
mod tests {
    /// Node's answer on the dev database (`.port-logs/api-node.ts inventory-history-diagnostics`).
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node(
            "inventory-history-diagnostics",
            &["/diagnostics/generatedAt"],
        )
        .await;
    }
}
