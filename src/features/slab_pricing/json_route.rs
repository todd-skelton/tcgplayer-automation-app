//! `/api/slab-recommendations`: a stored recommendation (`GET ?id=`), a new one calculated from
//! saved evidence (`POST` `calculate`) and the operator's reviewed ask on one (`POST`
//! `override`), as the Node route answered them, never stored by a cache. A calculation's policy
//! and seller are read from the JSON as Node's validators read them: a seller amount left out is
//! refused (an unknown one is an explicit `null`), and `fees` that JavaScript reads as false are
//! none.
use corten::json::Raw;
use corten::{
    Api, JsonError, JsonResponse, Prefix,
    axum::body::to_bytes,
    extract::Request,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    prelude::*,
};
use serde_json::Value;
use sqlx::PgConnection;

use super::{calculation, publication::is_id, recommendation, valuation};
use crate::{api, app::Shared, database::Database};

/// The largest request Node read (`readSlabJsonRequest`).
const MAX_BODY_BYTES: usize = 16 * 1024;
/// What Node answered for anything but a valuation's own refusal.
const UNABLE: &str = "Unable to calculate a slab recommendation.";

#[derive(Route)]
#[route("/api/slab-recommendations")]
pub struct SlabRecommendations {
    /// Every `id` sent; Node read the first (`searchParams.get`).
    pub id: Vec<String>,
}

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
async fn show(
    State(db): State<Database>,
    Params(asked): Params<SlabRecommendations>,
) -> JsonResponse {
    let id = asked.id.first().cloned().unwrap_or_default();
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

/// A `calculate` or an `override`, each answered as Node answered it.
async fn act(State(db): State<Database>, request: Request) -> Result<JsonResponse, JsonError> {
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
        Some("calculate") => {
            let as_of = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            own(match db.0.acquire().await {
                Ok(mut conn) => calculated(&mut conn, &input, &as_of).await,
                Err(_) => failure(None, false),
            })
        }
        Some("override") => own(reviewed(&db, &input).await),
        _ => own(failure(Some("Choose calculate or override."), false)),
    }
}

const IDENTITY: &str = "Choose a current slab identity and at most twenty evidence revisions.";
const POLICY: &str = "Provide a valid, bounded slab pricing policy.";
const SELLER: &str =
    "Provide seller costs and fees in the pricing currency; unknown values must be explicit nulls.";

/// `calculateSlabRecommendation` at `as_of`: `{id, calculation}`, or why not.
async fn calculated(conn: &mut PgConnection, input: &Value, as_of: &str) -> JsonResponse {
    let asked = match asked_of(input) {
        Ok(asked) => asked,
        Err(why) => return failure(Some(why), false),
    };
    let ask = calculation::Asked {
        slab_id: &asked.slab_id,
        identity_revision: asked.identity_revision,
        revision_ids: &asked.revision_ids,
        policy: &asked.policy,
        seller: &asked.seller,
        replacing: None,
    };
    match calculation::calculate(conn, &ask, as_of).await {
        Ok(calculated) => {
            let body = format!(
                r#"{{"id":{},"calculation":{}}}"#,
                Value::from(calculated.id),
                calculated.calculation
            );
            match Raw::new(body) {
                Ok(raw) => unstored(Json(raw).into()),
                Err(_) => failure(None, false),
            }
        }
        Err(why) if why == UNABLE => failure(None, false),
        Err(why) => failure(Some(&why), false),
    }
}

/// What a calculation asks for, read from the JSON.
struct AskedFor {
    slab_id: String,
    identity_revision: i64,
    revision_ids: Vec<String>,
    policy: valuation::Policy,
    seller: recommendation::Seller,
}

/// The body read in Node's order: the slab and evidence, then the policy, then the seller.
fn asked_of(input: &Value) -> Result<AskedFor, &'static str> {
    let slab_id = input
        .get("slabId")
        .and_then(Value::as_str)
        .filter(|id| is_id(id))
        .ok_or(IDENTITY)?;
    // `Number.isSafeInteger`: a JSON number, whole.
    let identity_revision = input
        .get("identityRevision")
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= 9_007_199_254_740_991.0)
        .ok_or(IDENTITY)? as i64;
    let revision_ids = input
        .get("revisionIds")
        .and_then(Value::as_array)
        .filter(|ids| ids.len() <= 20)
        .and_then(|ids| {
            ids.iter()
                .map(|id| id.as_str().filter(|id| is_id(id)).map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or(IDENTITY)?;
    let policy: valuation::Policy = input
        .get("policy")
        .and_then(|policy| serde_json::from_value(policy.clone()).ok())
        .ok_or(POLICY)?;
    let policy = valuation::validate_policy(&policy).map_err(|_| POLICY)?;
    let seller = seller_of(input.get("seller"), &policy.currency).ok_or(SELLER)?;
    Ok(AskedFor {
        slab_id: slab_id.to_owned(),
        identity_revision,
        revision_ids,
        policy,
        seller,
    })
}

/// `validateSellerPriceContext` of the JSON: every amount sent, a number or `null`; `fees` none
/// when JavaScript reads them as false, otherwise a rate, a fixed amount and a basis.
fn seller_of(value: Option<&Value>, currency: &str) -> Option<recommendation::Seller> {
    let fields = value?.as_object()?;
    let amount = |key: &str| -> Option<Option<f64>> {
        match fields.get(key)? {
            Value::Null => Some(None),
            Value::Number(n) => n.as_f64().map(Some),
            _ => None,
        }
    };
    let fees = match fields.get("fees") {
        Some(fees) if truthy(fees) => {
            let fees = fees.as_object()?;
            Some(recommendation::Fees {
                rate: fees.get("rate")?.as_f64()?,
                fixed: fees.get("fixed")?.as_f64()?,
                basis: fees.get("basis")?.as_str()?.to_owned(),
            })
        }
        _ => None,
    };
    let seller = recommendation::Seller {
        currency: fields.get("currency")?.as_str()?.to_owned(),
        current_ask: amount("currentAsk")?,
        shipping_charged: amount("shippingCharged")?,
        shipping_cost: amount("shippingCost")?,
        acquisition_cost: amount("acquisitionCost")?,
        fees,
        minimum_ask: amount("minimumAsk")?,
        minimum_profit: amount("minimumProfit")?,
    };
    valuation::validate_seller(&seller, currency).ok()
}

/// What JavaScript reads as true.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
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

    /// Each request Node's route was asked (`scripts/parity/record-node-answers.ts slab-recommendations`) gets the
    /// status, `Cache-Control` and JSON it gave, on the dev database: its refusals, since dev has
    /// no recommendation to read or review.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-recommendations", &[]).await;
    }

    /// A post from another site is refused by Corten before the route reads it, with its own
    /// message, where Node said "Submit this request from the application." The status is Node's.
    #[tokio::test]
    async fn corten_refuses_a_post_from_another_site() {
        use corten::http::{Method, header};

        use crate::{database::Database, legacy::Legacy};

        let answer = crate::app::app(crate::app::Shared {
            db: Database::connect_lazy("postgresql://localhost/unused"),
            legacy: Legacy::new("http://localhost:1".into()),
            slab_providers: crate::features::slab_connections::Transport::default(),
        })
        .test()
        .call(Method::POST, &super::SlabRecommendations { id: Vec::new() })
        .header(header::HOST, "localhost")
        .header(header::ORIGIN, "http://evil.example")
        .body("application/json", r#"{"intent":"override"}"#)
        .await;
        assert_eq!(answer.status(), 403);
        assert_eq!(answer.text(), r#"{"error":"Cross-site request refused."}"#);
    }
}
