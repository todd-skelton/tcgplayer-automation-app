//! `/api/slab-comp-decisions`: the operator's comp decisions in a valuation group (`GET
//! ?group=&revisions=`) and saving one (`POST`), as the Node route answered them, never stored by
//! a cache.
//!
//! Where it can still differ from Node, each on a request the Node app's own client never sends:
//! a reviewed item price that is `0`, `""` or `false` Node saved as given, where it is refused
//! here; and a reviewed item price's fields beyond its amount and currency are not kept.
use corten::{
    Api, JsonResponse, Prefix,
    axum::body::to_bytes,
    extract::Request,
    http::{StatusCode, header},
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgExecutor};

use super::{
    comps::{Decided, NotDecided, decide},
    json_route::{same_origin, unstored},
    screening::{Decision, Money},
};
use crate::{api, app::Shared, database::Database};

/// The largest request Node read.
const MAX_BODY_BYTES: usize = 16 * 1024;
/// What Node answered for anything but a review's own refusal, reading or saving.
const UNABLE: &str = "Unable to save the comp review.";
/// The most revisions read at once.
const MOST_REVISIONS: usize = 50;
/// The most decisions answered.
const MOST_DECISIONS: usize = 2000;

#[derive(Route)]
#[route("/api/slab-comp-decisions")]
pub struct SlabCompDecisions {
    /// Every `group` and `revisions` sent; Node read the first of each (`searchParams.get`).
    pub group: Vec<String>,
    pub revisions: Vec<String>,
}

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<SlabCompDecisions>(get(show).post(save).with_state(shared.clone()))
}

/// Node's `failure`: a review's refusal says why (400, or 409 for an identity changed since); a
/// request that does not read is a 400 and anything else a 500, both saying only that it was
/// unable.
fn failure(not: &NotDecided) -> JsonResponse {
    unstored(match not {
        NotDecided::Refused(why) => api::error(StatusCode::BAD_REQUEST, why),
        NotDecided::Conflict(why) => api::error(StatusCode::CONFLICT, why),
        NotDecided::Failed(_) => api::error(StatusCode::INTERNAL_SERVER_ERROR, UNABLE),
    })
}

fn unreadable() -> JsonResponse {
    unstored(api::error(StatusCode::BAD_REQUEST, UNABLE))
}

/// `{ decisions }` in the group for the revisions.
async fn show(
    State(db): State<Database>,
    Params(asked): Params<SlabCompDecisions>,
) -> JsonResponse {
    let group = asked.group.first().cloned().unwrap_or_default();
    let revisions = asked.revisions.first().cloned().unwrap_or_default();
    let revisions: Vec<&str> = revisions.split(',').filter(|r| !r.is_empty()).collect();
    match decisions(&db.0, &group, &revisions).await {
        Ok(decisions) => unstored(api::node_json(&json!({ "decisions": decisions }))),
        Err(not) => failure(&not),
    }
}

/// `getCompDecisions`: the decisions saved in the group on the revisions, by revision and sale.
pub(super) async fn decisions(
    db: impl PgExecutor<'_>,
    group: &str,
    revisions: &[&str],
) -> Result<Vec<Value>, NotDecided> {
    let group_key = group.len() == 64
        && group
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !group_key || revisions.len() > MOST_REVISIONS || !revisions.iter().all(|r| is_uuid(r)) {
        return Err(NotDecided::Refused(
            "Choose a valuation group and at most fifty evidence revisions.",
        ));
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT decision FROM slab_comp_decisions WHERE valuation_group_key = $1 AND revision_id = ANY($2::uuid[]) ORDER BY revision_id, event_key LIMIT 2001",
    )
    .bind(group)
    .bind(revisions)
    .fetch_all(db)
    .await
    .map_err(|e| NotDecided::Failed(e.to_string()))?;
    if rows.len() > MOST_DECISIONS {
        return Err(NotDecided::Refused(
            "Narrow the evidence selection before loading reviews.",
        ));
    }
    Ok(rows)
}

/// A lowercase UUID, as Node's `uuid` reads one.
fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// `{ decision }` saved, from a page of the app's own origin.
async fn save(State(db): State<Database>, request: Request) -> JsonResponse {
    let (parts, body) = request.into_parts();
    if !same_origin(&parts.headers) {
        let why = "Submit this review from the application.";
        return unstored(api::error(StatusCode::FORBIDDEN, why));
    }
    let json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    if !json.is_some_and(|t| t.starts_with("application/json")) {
        return unreadable();
    }
    let Ok(body) = to_bytes(body, MAX_BODY_BYTES).await else {
        return unreadable();
    };
    // Not JSON, or `null`, whose fields are a TypeError.
    let input = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Null) | Err(_) => return unreadable(),
        Ok(input) => input,
    };
    let saved = match db.0.acquire().await {
        Ok(mut conn) => saved(&mut conn, &input).await,
        Err(error) => Err(NotDecided::Failed(error.to_string())),
    };
    match saved {
        Ok(decision) => unstored(api::node_json(&json!({ "decision": decision }))),
        Err(not) => failure(&not),
    }
}

/// `saveCompDecision` of the request as Node read it: a field of the wrong type is refused as one
/// missing.
pub(super) async fn saved(conn: &mut PgConnection, input: &Value) -> Result<Decision, NotDecided> {
    let text = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    // `Number.isSafeInteger`; anything else is refused as revision 0.
    let identity_revision = input
        .get("identityRevision")
        .and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .map_or(0, |n| n as i64);
    // A date is `null` or a day; one missing or not text is refused as one that is not a day.
    let date = match input.get("date") {
        Some(Value::Null) => None,
        Some(Value::String(day)) => Some(day.as_str()),
        _ => Some(""),
    };
    // `input.itemPrice ?? null`; a price whose amount or currency does not read is refused.
    let item_price = match input.get("itemPrice") {
        None | Some(Value::Null) => None,
        Some(price) => Some(Money {
            amount: price
                .get("amount")
                .and_then(Value::as_f64)
                .unwrap_or(f64::NAN),
            currency: price
                .get("currency")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }),
    };
    let decided = Decided {
        slab_id: text("slabId"),
        identity_revision,
        revision_id: text("revisionId"),
        provider: text("provider"),
        provider_id: text("providerId"),
        date,
        decision: text("decision"),
        note: text("note"),
        item_price,
    };
    decide(conn, &decided).await
}

#[cfg(test)]
mod tests {
    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts slab-comp-decisions`): its
    /// refusals, since dev has no slab to review. What a save writes is compared with Node's in
    /// `comps::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-comp-decisions", &[]).await;
    }
}
