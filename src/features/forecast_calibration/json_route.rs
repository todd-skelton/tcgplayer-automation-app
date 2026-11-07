//! `GET /api/forecast-calibration?days=`: the report as JSON, as the Node route answered it.
use chrono::Utc;
use corten::{Api, JsonResponse, Params, Prefix, http::StatusCode, prelude::*};

use super::{DEFAULT_WINDOW_DAYS, WINDOW_DAYS, load};
use crate::{api, app::Shared, database::Database};

/// Every `days` sent: Node read the first (`searchParams.get`) and answered its own error for
/// one that is not a window, so the route takes them as text.
#[derive(Route)]
#[route("/api/forecast-calibration")]
pub struct ForecastCalibration {
    pub days: Vec<String>,
}

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<ForecastCalibration>(get(report).with_state(shared.clone()))
}

/// The calibration over `days` (one of [`WINDOW_DAYS`], [`DEFAULT_WINDOW_DAYS`] when not
/// sent); a 500 with why when it cannot be learned.
async fn report(State(db): State<Database>, asked: Params<ForecastCalibration>) -> JsonResponse {
    let days = asked
        .days
        .first()
        .map_or(Some(f64::from(DEFAULT_WINDOW_DAYS)), |sent| {
            api::js_number(sent)
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

    /// A query Node's `URLSearchParams` read without complaint (a bad escape kept as text, bytes
    /// that are not UTF-8 replaced, a name with no `=`) gets Node's own error for a `days` that
    /// is not a window, not a refusal of the query, before the database is asked.
    #[tokio::test]
    async fn a_malformed_query_gets_nodes_error() {
        let client = app(Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .test();
        for query in [
            "days=%zz",
            "days=%FF",
            "days",
            "days=%zz&days=28",
            "days=+28+",
            "a=1&da%79s=+28",
        ] {
            let path = format!("/api/forecast-calibration?{query}");
            let answer = client.get(&corten::Local::parse(&path).unwrap()).await;
            let body: Value = serde_json::from_slice(answer.bytes()).unwrap();
            if query.contains("=+28") {
                // `Number(" 28 ")` is 28 (an escaped name and `+` as a space read as
                // `URLSearchParams` reads them): the database is asked, and it is not there.
                assert_eq!(answer.status().as_u16(), 500, "{query}: {body}");
            } else {
                assert_eq!(answer.status().as_u16(), 400, "{query}: {body}");
                assert!(
                    body["error"]
                        .as_str()
                        .is_some_and(|e| e.starts_with("days must be one of")),
                    "{query}: {body}"
                );
            }
        }
    }

    /// The ported route sits beside the relay: every other JSON route still goes to the Node app,
    /// whose failure to answer is said in its shape.
    #[tokio::test]
    async fn other_json_routes_still_reach_the_node_app() {
        let answer = app(Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://127.0.0.1:1".into()),
            slab_providers: slab_connections::Transport::default(),
        })
        .test()
        // A route the port does not serve, so no route names it.
        .get(&corten::Local::parse("/api/validate-skus").unwrap())
        .await;
        let status = answer.status();
        let body: Value = serde_json::from_slice(answer.bytes()).unwrap();
        assert!(status.is_server_error(), "{status}");
        assert!(body["error"].is_string(), "{body}");
    }
}
