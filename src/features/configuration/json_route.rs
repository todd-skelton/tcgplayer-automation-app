//! `/api/pricing-config`: the pricing configuration as JSON, as the Node route answered it. `GET`
//! reads it normalized (the defaults written first when there is none), and `PUT` replaces it
//! with the body normalized (`normalizeServerPricingConfig`), answering with it read again.
use corten::{
    Api, JsonResponse, Prefix,
    http::{Request, StatusCode},
    prelude::*,
};
use serde_json::{Value, json};

use super::config::{self, normalized};
use crate::{api, app::Shared, database::Database, node_pg};

const CONFIG_KEY: &str = "default";

/// The largest body read: the configuration, its product lines included.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/pricing-config")]
pub struct PricingConfig;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<PricingConfig>(
        get(show)
            .put(replace)
            .post(not_allowed)
            .patch(not_allowed)
            .delete(not_allowed)
            .with_state(shared.clone()),
    )
}

/// The stored configuration normalized, with when it was saved (`pricingConfigRepository.get`);
/// the defaults saved first when there is none.
async fn read(db: &Database) -> Result<Value, String> {
    let select = || {
        sqlx::query(
            r#"SELECT pricing_json AS "pricing", supply_analysis_json AS "supplyAnalysis",
                product_line_pricing_json AS "productLinePricing", updated_at AS "updatedAt"
            FROM pricing_config WHERE config_key = $1"#,
        )
        .bind(CONFIG_KEY)
        .fetch_optional(&db.0)
    };
    let row = match select().await.map_err(node_pg::thrown)? {
        Some(row) => row,
        None => {
            config::reset(db).await.map_err(node_pg::thrown)?;
            select()
                .await
                .map_err(node_pg::thrown)?
                .ok_or("Error: the pricing configuration was not saved")?
        }
    };
    let row = node_pg::row(&row)?;
    let mut answer = normalized(
        &row["pricing"],
        &row["supplyAnalysis"],
        &row["productLinePricing"],
    );
    answer["updatedAt"] = row["updatedAt"].clone();
    Ok(answer)
}

/// Node's error answer for the loader: the defaults with why.
fn failed(message: String) -> JsonResponse {
    let mut answer = normalized(&Value::Null, &Value::Null, &Value::Null);
    answer["error"] = message.into();
    Json(answer).with_status(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn show(State(db): State<Database>) -> JsonResponse {
    match read(&db).await {
        Ok(answer) => api::node_json(&answer),
        Err(message) => failed(message),
    }
}

/// The body normalized and saved in place of the stored documents, then read again.
async fn replace(State(db): State<Database>, request: Request) -> JsonResponse {
    let saved = async {
        let bytes = crate::api::body_up_to(request.into_body(), MAX_BODY_BYTES)
            .await
            .map_err(|e| format!("Error: {e}"))?;
        let body: Value =
            serde_json::from_slice(&bytes).map_err(|e| format!("SyntaxError: {e}"))?;
        let config = normalized(
            &body["pricing"],
            &body["supplyAnalysis"],
            &body["productLinePricing"],
        );
        sqlx::query(
            "INSERT INTO pricing_config (config_key, pricing_json, supply_analysis_json,
                product_line_pricing_json, updated_at)
            VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, NOW())
            ON CONFLICT (config_key) DO UPDATE SET
                pricing_json = EXCLUDED.pricing_json,
                supply_analysis_json = EXCLUDED.supply_analysis_json,
                product_line_pricing_json = EXCLUDED.product_line_pricing_json,
                updated_at = NOW()",
        )
        .bind(CONFIG_KEY)
        .bind(&config["pricing"])
        .bind(&config["supplyAnalysis"])
        .bind(&config["productLinePricing"])
        .execute(&db.0)
        .await
        .map_err(node_pg::thrown)?;
        read(&db).await
    };
    match saved.await {
        Ok(answer) => api::node_json(&answer),
        Err(message) => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

async fn not_allowed() -> JsonResponse {
    Json(json!({ "error": "Method not allowed" })).with_status(StatusCode::METHOD_NOT_ALLOWED)
}
