//! `/api/slab-identities`: a certificate's identity looked up (`lookup`, which asks Alt unless it
//! is saved) and confirmed by the operator (`confirm`), by `POST`, as the Node route answered
//! them, never stored by a cache.
use corten::{
    Api, JsonResponse, Prefix, Signal,
    axum::{body::to_bytes, extract::Request},
    http::StatusCode,
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    identity::{self, CHANGED, Confirmation, UNABLE, Unresolved, normalized_certificate},
    inventory::{Expected, identity_conflicts},
    json_route::{same_origin, unstored},
};
use crate::{
    api,
    app::Shared,
    database::Database,
    features::{
        slab_connections::{DatabaseGate, Transport},
        slab_evidence::alt::Alt,
    },
};

/// The largest request read; Node read any.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/slab-identities")]
pub struct SlabIdentities;

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<SlabIdentities>(post(act).with_state(shared.clone()))
}

/// Why a request was not answered, as Node's `SlabIdentityError`, Alt's status or the database.
enum Refused {
    /// `invalid-input` (400) or `conflict` (409), with why.
    Identity(&'static str, String),
    Provider(crate::features::slab_connections::ConnectionStatus),
    Unavailable,
}

fn invalid(why: impl Into<String>) -> Refused {
    Refused::Identity("invalid-input", why.into())
}

fn failure(refused: &Refused) -> JsonResponse {
    unstored(match refused {
        Refused::Identity(code, why) => {
            let status = if *code == "conflict" {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            api::node_json(&json!({ "error": why, "code": code })).with_status(status)
        }
        Refused::Provider(status) => {
            api::node_json(&json!({ "error": status.message(), "code": status.as_ref() }))
                .with_status(StatusCode::SERVICE_UNAVAILABLE)
        }
        Refused::Unavailable => api::error(StatusCode::INTERNAL_SERVER_ERROR, UNABLE),
    })
}

/// A post from a page of the app's own origin, its body JSON whatever it says it is.
async fn act(
    State(db): State<Database>,
    State(transport): State<Transport>,
    signal: Signal,
    request: Request,
) -> JsonResponse {
    let (parts, body) = request.into_parts();
    if !same_origin(&parts.headers) {
        let why = "Submit this request from the application.";
        return unstored(api::error(StatusCode::FORBIDDEN, why));
    }
    let input = match to_bytes(body, MAX_BODY_BYTES).await {
        Ok(body) => serde_json::from_slice::<Value>(&body).ok(),
        Err(_) => None,
    };
    let Some(input) = input else {
        return unstored(api::error(StatusCode::BAD_REQUEST, "Provide valid JSON."));
    };
    match acted(&db, transport, &signal, &input).await {
        Ok(answer) => unstored(api::node_json(&answer)),
        Err(refused) => failure(&refused),
    }
}

async fn acted(
    db: &Database,
    transport: Transport,
    signal: &Signal,
    input: &Value,
) -> Result<Value, Refused> {
    if !(input.is_object() || input.is_array()) {
        return Err(invalid("Provide an identity request."));
    }
    match input["intent"].as_str() {
        Some("lookup") => {
            let asked = lookup_input(input)?;
            let record = look_up(db, transport, signal, &asked).await?;
            let mut conn = db.0.acquire().await.map_err(unavailable)?;
            looked_up(&mut conn, &record, &asked.expected).await
        }
        Some("confirm") => {
            let mut conn = db.0.acquire().await.map_err(unavailable)?;
            confirmed(&mut conn, input).await
        }
        _ => Err(invalid("Choose lookup or confirm.")),
    }
}

/// A lookup as asked: the certificate, what it is expected to be, and whether to ask Alt again
/// while it is unconfirmed.
struct LookUp {
    grader: String,
    number: String,
    expected: Expected,
    refresh: bool,
}

/// The lookup read in the order Node reads it: `expected` left out or an object, then the
/// certificate, then what it expects.
fn lookup_input(input: &Value) -> Result<LookUp, Refused> {
    let expected = match input.get("expected") {
        None => &Value::Null,
        Some(expected) if expected.is_object() => expected,
        Some(_) => return Err(invalid("Expected card fields must be an object.")),
    };
    let (grader, number) =
        normalized_certificate(&input["grader"], &input["certificateNumber"]).map_err(invalid)?;
    Ok(LookUp {
        grader,
        number,
        expected: identity::expected(expected).map_err(invalid)?,
        refresh: input["refresh"] == true,
    })
}

/// `{ record, reviewReasons }`: the identity as saved, and why it needs review, where it
/// disagrees with what was expected included.
async fn looked_up(
    conn: &mut PgConnection,
    record: &identity::Record,
    expected: &Expected,
) -> Result<Value, Refused> {
    let mut reasons = record.review_reasons.clone();
    reasons.extend(identity_conflicts(record.shown(), expected));
    let stored = answered(conn, &record.id).await?;
    Ok(json!({ "record": stored, "reviewReasons": reasons }))
}

/// `{ record }`: the identity confirmed as asked, as saved.
async fn confirmed(conn: &mut PgConnection, input: &Value) -> Result<Value, Refused> {
    // `Number.isSafeInteger`; anything else is refused as revision 0.
    let revision = input["revision"]
        .as_f64()
        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .map_or(0, |n| n as i64);
    let confirmation = Confirmation {
        grader: &input["grader"],
        certificate_number: &input["certificateNumber"],
        revision,
        identity: &input["identity"],
        note: &input["note"],
    };
    let id = identity::confirm(conn, &confirmation)
        .await
        .map_err(|why| match why.as_str() {
            CHANGED => Refused::Identity("conflict", why),
            UNABLE => Refused::Unavailable,
            _ => invalid(why),
        })?;
    Ok(json!({ "record": answered(conn, &id).await? }))
}

fn unavailable(error: impl std::fmt::Display) -> Refused {
    eprintln!("slab identity: {error}");
    Refused::Unavailable
}

/// Looks the certificate up on a connection of its own while the request waits: the client
/// leaving cancels Alt's request, and the Alt connection's lease is released either way.
async fn look_up(
    db: &Database,
    transport: Transport,
    signal: &Signal,
    asked: &LookUp,
) -> Result<identity::Record, Refused> {
    let (db, grader, number, refresh) = (
        db.clone(),
        asked.grader.clone(),
        asked.number.clone(),
        asked.refresh,
    );
    signal
        .finish(move |signal| async move {
            let gate = DatabaseGate(db.clone());
            let alt = Alt {
                transport: &transport,
                gate: &gate,
            };
            let cancel = async move {
                signal.aborted().await;
            };
            let mut conn = db.0.acquire().await.map_err(unavailable)?;
            identity::lookup(&mut conn, &alt, (&grader, &number), refresh, cancel)
                .await
                .map_err(|unresolved| match unresolved {
                    Unresolved::Refused(why) => invalid(why),
                    Unresolved::Provider(status) => Refused::Provider(status),
                    Unresolved::Unavailable => Refused::Unavailable,
                })
        })
        .await
}

/// The identity saved, every column, as Node answered it.
async fn answered(conn: &mut PgConnection, id: &str) -> Result<Value, Refused> {
    identity::answered(conn, id)
        .await
        .map_err(unavailable)?
        .ok_or(Refused::Unavailable)
}

#[cfg(test)]
mod tests {

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts slab-identities`): every
    /// refusal before Alt is asked or anything is saved. What a lookup asks Alt and saves, and
    /// what a confirmation saves, are compared with Node's in `identity::tests` and
    /// `inventory_import::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-identities", &[]).await;
    }
}
