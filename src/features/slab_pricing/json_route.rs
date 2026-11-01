//! `/api/slab-recommendations`: a stored recommendation (`GET ?id=`) and the operator's reviewed
//! ask on it (`POST` `override`), as the Node route answered them, never stored by a cache. A
//! `calculate` still goes to the Node app until its policy and seller read JSON as Node validates
//! them.
use corten::{
    Api, JsonError, JsonResponse, Prefix,
    axum::{
        body::{Body, to_bytes},
        extract::{RawQuery, Request},
        http::{HeaderMap, HeaderValue, StatusCode, header},
    },
    prelude::*,
};
use serde_json::Value;

use super::{publication::is_id, recommendation};
use crate::{
    api,
    app::Shared,
    database::Database,
    legacy::{Legacy, relay_request},
};

/// The largest request Node read (`readSlabJsonRequest`).
const MAX_BODY_BYTES: usize = 16 * 1024;
/// What Node answered for anything but a valuation's own refusal.
const UNABLE: &str = "Unable to calculate a slab recommendation.";

#[derive(Route)]
#[route("/api/slab-recommendations")]
pub struct SlabRecommendations;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    let api = api.route::<SlabRecommendations>(get(show).post(act).with_state(shared.clone()));
    let api = super::inventory_route::routes(api, shared);
    let api = super::evidence_route::routes(api, shared);
    let api = super::identities_route::routes(api, shared);
    super::comp_decisions_route::routes(api, shared)
}

/// An answer no cache keeps, as Node sent each one.
pub(super) fn unstored(mut answer: JsonResponse) -> JsonResponse {
    answer
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    answer
}

/// Node's `failure`: a valuation's refusal says why (400); a request that does not read is a 400
/// and anything else a 500, both saying only that it was unable.
fn failure(refused: Option<&str>, unreadable: bool) -> JsonResponse {
    unstored(match refused {
        Some(message) => api::error(StatusCode::BAD_REQUEST, message),
        None if unreadable => api::error(StatusCode::BAD_REQUEST, UNABLE),
        None => api::error(StatusCode::INTERNAL_SERVER_ERROR, UNABLE),
    })
}

/// The recommendation `id`, whether it is current, and its reviewed ask.
async fn show(State(db): State<Database>, RawQuery(query): RawQuery) -> JsonResponse {
    let id = api::first(query.as_deref(), "id").unwrap_or_default();
    if !is_id(&id) {
        return failure(Some("Choose a recommendation."), false);
    }
    match read(&db, &id).await {
        Ok(Some(record)) => unstored(api::node_json(&record)),
        Ok(None) => unstored(api::error(
            StatusCode::NOT_FOUND,
            "Recommendation not found.",
        )),
        Err(()) => failure(None, false),
    }
}

async fn read(db: &Database, id: &str) -> Result<Option<Value>, ()> {
    sqlx::query_scalar(recommendation::BY_ID)
        .bind(id)
        .fetch_optional(&db.0)
        .await
        .map_err(|e| eprintln!("slab recommendation: {e}"))
}

/// `override` answered here; `calculate` by the Node app, its answer passed on as it came.
async fn act(
    State(db): State<Database>,
    State(legacy): State<Legacy>,
    request: Request,
) -> Result<JsonResponse, JsonError> {
    let own = Ok;
    let (parts, body) = request.into_parts();
    if !same_origin(&parts.headers) {
        let refused = api::error(
            StatusCode::FORBIDDEN,
            "Submit this request from the application.",
        );
        return own(unstored(refused));
    }
    let json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    if !json.is_some_and(|t| t.starts_with("application/json")) {
        return own(failure(None, true));
    }
    let Ok(body) = to_bytes(body, MAX_BODY_BYTES).await else {
        return own(failure(None, true));
    };
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return own(failure(None, true));
    };
    if input.is_null() {
        // `input.intent` of `null` is a TypeError.
        return own(failure(None, true));
    }
    match input.get("intent").and_then(Value::as_str) {
        Some("calculate") => Ok(relay_request(
            &legacy,
            Request::from_parts(parts, Body::from(body)),
        )
        .await?
        .into()),
        Some("override") => own(reviewed(&db, &input).await),
        _ => own(failure(Some("Choose calculate or override."), false)),
    }
}

/// `overrideSlabPrice`: the ask saved, then the recommendation read again.
async fn reviewed(db: &Database, input: &Value) -> JsonResponse {
    let text = |key: &str| input.get(key).and_then(Value::as_str);
    let id = text("recommendationId").unwrap_or_default();
    // A note that is not text, or an amount that is not a number, is refused as Node refuses it.
    let note = text("note");
    let ask = recommendation::ReviewedAsk {
        recommendation_id: id,
        item_price: input
            .get("itemPrice")
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN),
        currency: text("currency").unwrap_or_default(),
        note: note.unwrap_or_default(),
    };
    let Ok(mut conn) = db.0.acquire().await else {
        return failure(None, false);
    };
    match recommendation::review_ask(&mut conn, &ask).await {
        Err(message) if message == UNABLE => failure(None, false),
        Err(message) => failure(Some(&message), false),
        Ok(()) => match read(db, id).await {
            Ok(Some(record)) => unstored(api::node_json(&record)),
            Ok(None) => unstored(api::node_json(&Value::Null)),
            Err(()) => failure(None, false),
        },
    }
}

/// Node took a post only from a page of its own origin: an `Origin` naming the host asked. Either
/// scheme passes, as Corten's own check before it lets one through; Node also held the scheme to
/// the one its request URL had. A post with no `Origin`, which Corten lets through as not a
/// browser's, is refused here as Node refused it.
pub(super) fn same_origin(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    match (origin, host) {
        (Some(origin), Some(host)) => {
            origin.split_once("://").is_some_and(|(scheme, authority)| {
                matches!(scheme, "http" | "https") && authority == host
            })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    /// Each request Node's route was asked (`.port-logs/api-node.ts slab-recommendations`) gets the
    /// status, `Cache-Control` and JSON it gave, on the dev database: its refusals, since dev has
    /// no recommendation to read or review.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in .port-logs"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-recommendations", &[]).await;
    }

    /// A post from another site is refused by Corten before the route reads it, with its own
    /// message, where Node said "Submit this request from the application." The status is Node's.
    #[tokio::test]
    async fn corten_refuses_a_post_from_another_site() {
        use corten::axum::{body::Body, http::Request};
        use tower::ServiceExt;

        use crate::{database::Database, legacy::Legacy};

        let router = crate::app::app(crate::app::Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: crate::features::slab_connections::Transport::default(),
        })
        .router();
        let post = Request::post("/api/slab-recommendations")
            .header("host", "localhost")
            .header("origin", "http://evil.example")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"intent":"override"}"#))
            .unwrap();
        let answer = router.oneshot(post).await.unwrap();
        assert_eq!(answer.status(), 403);
        let body = corten::axum::body::to_bytes(answer.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], br#"{"error":"Cross-site request refused."}"#);
    }
}
