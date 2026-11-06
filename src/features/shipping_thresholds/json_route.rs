//! `GET /api/shipping-thresholds?days=`: the shipping threshold report as JSON, as the Node
//! route answered it.
use chrono::Utc;
use corten::{Api, JsonResponse, Params, Prefix, http::StatusCode, prelude::*};

use super::report::load;
use crate::{
    api,
    app::Shared,
    database::Database,
    features::configuration::config::{self, EVIDENCE_WINDOWS},
};

#[derive(Route)]
#[route("/api/shipping-thresholds")]
pub struct ShippingThresholds {
    /// Every `days` sent; Node read the first (`searchParams.get`).
    pub days: Vec<String>,
}

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<ShippingThresholds>(get(report).with_state(shared.clone()))
}

/// The report over `days` of outcomes (one of [`EVIDENCE_WINDOWS`], the snaps' own evidence
/// window when not sent), under the stored snaps and overhead; a 500 with why when it cannot be
/// read.
async fn report(
    State(db): State<Database>,
    Params(asked): Params<ShippingThresholds>,
) -> JsonResponse {
    let config = match config::load(&db).await {
        Ok(config) => config,
        Err(error) => return api::error(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    let days = asked
        .days
        .first()
        .map_or(Some(f64::from(config.snaps.evidence_window_days)), |sent| {
            api::js_number(sent)
        });
    let Some(days) = days.and_then(|d| EVIDENCE_WINDOWS.into_iter().find(|w| f64::from(*w) == d))
    else {
        let allowed = EVIDENCE_WINDOWS.map(|d| d.to_string()).join(", ");
        return api::error(
            StatusCode::BAD_REQUEST,
            format!("days must be one of {allowed}."),
        );
    };
    let overhead = config.pricing.profit_per_day.relative_overhead;
    match load(&db, &config.snaps, overhead, days, Utc::now()).await {
        Ok(report) => api::node_json(&report),
        Err(error) => api::error(StatusCode::INTERNAL_SERVER_ERROR, error),
    }
}

#[cfg(test)]
mod tests {
    /// Each query Node's loader was asked (`scripts/parity/record-node-answers.ts shipping-thresholds`) gets the
    /// status and JSON it gave, on the dev database. When the cost model was learned differs.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("shipping-thresholds", &["/costModel/learnedAt"]).await;
    }
}
