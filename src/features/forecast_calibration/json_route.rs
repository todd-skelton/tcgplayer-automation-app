//! `GET /api/forecast-calibration?days=`: the report as JSON, as the Node route answered it.
use chrono::Utc;
use corten::{Api, JsonResponse, Prefix, axum::extract::RawQuery, http::StatusCode, prelude::*};

use super::{DEFAULT_WINDOW_DAYS, WINDOW_DAYS, load};
use crate::{api, app::Shared, database::Database};

#[derive(Route)]
#[route("/api/forecast-calibration")]
pub struct ForecastCalibration;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<ForecastCalibration>(get(report).with_state(shared.clone()))
}

/// The calibration over `days` (one of [`WINDOW_DAYS`], [`DEFAULT_WINDOW_DAYS`] when not
/// sent); a 500 with why when it cannot be learned.
async fn report(State(db): State<Database>, RawQuery(query): RawQuery) -> JsonResponse {
    let days = api::first(query.as_deref(), "days")
        .map_or(Some(f64::from(DEFAULT_WINDOW_DAYS)), |sent| {
            api::js_number(&sent)
        });
    let Some(days) = days.and_then(|d| WINDOW_DAYS.into_iter().find(|w| f64::from(*w) == d)) else {
        let allowed = WINDOW_DAYS.map(|d| d.to_string()).join(", ");
        return api::error(
            StatusCode::BAD_REQUEST,
            format!("days must be one of {allowed}."),
        );
    };
    match load(&db, days, Utc::now()).await {
        Ok(calibration) => api::node_json(&calibration),
        Err(error) => api::error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
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

    /// Each query Node's loader was asked (`scripts/parity/record-node-answers.ts forecast-calibration`) gets the
    /// status and JSON it gave, on the dev database. When it was learned is the only difference.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("forecast-calibration", &["/learnedAt"]).await;
    }

    /// The ported route sits beside the relay: every other JSON route still goes to the Node app,
    /// whose failure to answer is said in its shape.
    #[tokio::test]
    async fn other_json_routes_still_reach_the_node_app() {
        let router = app(Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .router();
        let request = corten::http::Request::get("/api/validate-skus")
            .body(corten::axum::body::Body::empty())
            .unwrap();
        let answer = router.oneshot(request).await.unwrap();
        let status = answer.status();
        let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(status.is_server_error(), "{status}");
        assert!(body["error"].is_string(), "{body}");
    }
}
