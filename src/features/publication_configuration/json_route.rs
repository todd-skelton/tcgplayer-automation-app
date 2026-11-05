//! `/api/inventory-publication-settings` and `/api/inventory-publication-health`: the publication
//! settings and the publisher's runtime as JSON, as the Node routes answered them. `GET` reads the
//! configuration, `PUT` replaces the settings with the body as the Node app normalizes it, and
//! `POST {"action":"resume"}` closes the circuit; health adds the publication queue's counts.
use corten::{
    Api, JsonResponse, Prefix,
    axum::{body::to_bytes, extract::Request, http::StatusCode},
    prelude::*,
};
use serde_json::{Value, json};

use super::config::{self, Settings};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{continuous_pricing::store as continuous, inventory_publication::policy::Policy},
    node_pg,
};

const CONFIG_KEY: &str = "default";

/// The largest body read: the settings document.
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Route)]
#[route("/api/inventory-publication-settings")]
pub struct InventoryPublicationSettings;

#[derive(Route)]
#[route("/api/inventory-publication-health")]
pub struct InventoryPublicationHealth;

/// The routes, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryPublicationSettings>(
        get(show)
            .put(replace)
            .post(act)
            .patch(not_allowed)
            .delete(not_allowed)
            .with_state(shared.clone()),
    )
    .route::<InventoryPublicationHealth>(get(health).with_state(shared.clone()))
}

/// A stored settings document as `normalizeInventoryPublicationSettings` writes it: every key,
/// each missing or out-of-range value its default.
pub fn document(stored: &Value) -> Value {
    let settings = Settings::of(stored);
    json!({
        "globalPaused": settings.global_paused,
        "consecutiveFailureLimit": settings.consecutive_failure_limit,
        "policy": Policy::of(&stored["policy"]).document(),
        "continuousPricing": continuous::Settings::of(&stored["continuousPricing"]),
    })
}

/// The settings and runtime (`inventoryPublicationSettingsRepository.get`), the row made first.
async fn configuration(db: &Database) -> Result<Value, String> {
    config::load(db).await.map_err(node_pg::thrown)?;
    let row = sqlx::query(
        r#"SELECT settings_json AS "settings",
            authentication_status AS "authenticationStatus",
            circuit_open AS "circuitOpen",
            consecutive_failures AS "consecutiveFailures",
            pause_reason AS "pauseReason",
            last_success_at AS "lastSuccessAt",
            last_failure_at AS "lastFailureAt",
            updated_at AS "updatedAt",
            runtime_updated_at AS "runtimeUpdatedAt"
        FROM inventory_publication_settings WHERE config_key = $1"#,
    )
    .bind(CONFIG_KEY)
    .fetch_one(&db.0)
    .await
    .map_err(node_pg::thrown)?;
    let row = node_pg::row(&row)?;
    let runtime: serde_json::Map<String, Value> = [
        "authenticationStatus",
        "circuitOpen",
        "consecutiveFailures",
        "pauseReason",
        "lastSuccessAt",
        "lastFailureAt",
        "runtimeUpdatedAt",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), row[key].clone()))
    .collect();
    Ok(json!({
        "settings": document(&row["settings"]),
        "runtime": runtime,
        "updatedAt": row["updatedAt"],
    }))
}

fn answer(read: Result<Value, String>) -> JsonResponse {
    match read {
        Ok(value) => api::node_json(&value),
        Err(message) => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}

async fn show(State(db): State<Database>) -> JsonResponse {
    answer(configuration(&db).await)
}

/// The request's JSON body, or what `request.json()` threw.
async fn body(request: Request) -> Result<Value, String> {
    let bytes = to_bytes(request.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|e| format!("Error: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("SyntaxError: {e}"))
}

/// The settings replaced by the body, normalized, then the configuration read again.
async fn replace(State(db): State<Database>, request: Request) -> JsonResponse {
    let saved = async {
        let settings = document(&body(request).await?);
        sqlx::query(
            "INSERT INTO inventory_publication_settings (config_key, settings_json, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (config_key) DO UPDATE SET
                settings_json = EXCLUDED.settings_json, updated_at = NOW()",
        )
        .bind(CONFIG_KEY)
        .bind(settings)
        .execute(&db.0)
        .await
        .map_err(node_pg::thrown)?;
        configuration(&db).await
    };
    answer(saved.await)
}

/// `{"action":"resume"}` closes the circuit and forgets the failures; any other action is refused.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let payload = match body(request).await {
        Ok(payload) => payload,
        Err(message) => return api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    if payload.get("action").and_then(Value::as_str) != Some("resume") {
        return api::error(StatusCode::BAD_REQUEST, "Unsupported action.");
    }
    let resumed = async {
        config::resume(&db).await.map_err(node_pg::thrown)?;
        configuration(&db).await
    };
    answer(resumed.await)
}

async fn not_allowed() -> JsonResponse {
    api::error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.")
}

/// The configuration and the publication queue's counts by status, its oldest planned
/// publication and its last publication (`getQueueHealth`).
async fn health(State(db): State<Database>) -> JsonResponse {
    let read = async {
        let configuration = configuration(&db).await?;
        let row = sqlx::query(
            r#"WITH status_counts AS (
                SELECT status, COUNT(*)::INTEGER AS count
                FROM inventory_publications
                GROUP BY status
            )
            SELECT
                COALESCE(jsonb_object_agg(status, count), '{}'::jsonb) AS counts,
                (SELECT MIN(created_at) FROM inventory_publications WHERE status = 'planned') AS "oldestPlannedAt",
                (SELECT MAX(published_at) FROM inventory_publications) AS "lastPublishedAt"
            FROM status_counts"#,
        )
        .fetch_one(&db.0)
        .await
        .map_err(node_pg::thrown)?;
        Ok::<_, String>(json!({ "configuration": configuration, "queue": node_pg::row(&row)? }))
    };
    answer(read.await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_names_every_setting_as_node_normalizes_it() {
        let stored = json!({
            "globalPaused": true,
            "policy": { "automaticSources": { "seller": true }, "stagedFlushWindowMs": 10 },
            "continuousPricing": { "sellerKey": "  8520a14f  ", "batchSize": 2000 },
            "retired": 1
        });
        let written = document(&stored);
        assert_eq!(written["globalPaused"], true);
        assert_eq!(written["consecutiveFailureLimit"], 3);
        assert_eq!(written["policy"]["automaticSources"]["seller"], true);
        assert_eq!(written["policy"]["automaticSources"]["csv"], false);
        assert_eq!(
            written["policy"]["stagedFlushWindowMs"], 60_000,
            "out of range"
        );
        assert_eq!(written["policy"]["minimumAbsolutePriceChange"], 0.01);
        assert_eq!(written["continuousPricing"]["sellerKey"], "8520a14f");
        assert_eq!(
            written["continuousPricing"]["batchSize"], 100,
            "out of range"
        );
        assert!(written.get("retired").is_none(), "only the known keys");
    }
}
