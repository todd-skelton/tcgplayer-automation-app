//! `/api/slab-inventory`: a page of the seller's listings (`GET ?seller=&after=&limit=`), and
//! importing listings (`import-csv`, `import-manual`) or tying one to an identity
//! (`resolve-identity`, which asks Alt, and `assign-identity`) by `POST`, as the Node route
//! answered them, never stored by a cache.
//!
//! Where it can still differ from Node, each on a request the Node app's own client never sends:
//! a body that is not UTF-8 is refused here as one that is not JSON, where Node refused it as a
//! field (both a 400 in the same words); and see [`super::inventory_import`] for a manual import.
use corten::{
    Api, JsonResponse, Prefix, Signal,
    http::Request,
    http::{StatusCode, header},
    prelude::*,
};
use serde_json::{Value, json};

use super::{
    identity,
    inventory::{self, Refused},
    inventory_import::{self, Imported, Resolved},
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

/// The largest request Node read.
const MAX_BODY_BYTES: usize = 3 * 1024 * 1024;
/// Anything that does not read: not JSON, too large, or a field refused as an identity field.
const FIELDS: &str = "Check the inventory request fields.";
/// `Number.MAX_SAFE_INTEGER`.
const MOST_SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(Route)]
#[route("/api/slab-inventory")]
pub struct SlabInventory {
    /// Every `limit`, `seller` and `after` sent; Node read the first of each
    /// (`searchParams.get`).
    pub limit: Vec<String>,
    pub seller: Vec<String>,
    pub after: Vec<String>,
}

pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<SlabInventory>(get(show).post(act).with_state(shared.clone()))
}

/// Node's `failure`: Alt's status (503, with its code), a conflict (409), a refusal (400), or
/// the database (500).
fn failure(refused: &Refused) -> JsonResponse {
    let message = refused.message();
    unstored(match refused {
        Refused::Provider(status) => api::node_json(&json!({
            "error": message,
            "code": status.as_ref(),
        }))
        .with_status(StatusCode::SERVICE_UNAVAILABLE),
        Refused::Conflict(_) => api::error(StatusCode::CONFLICT, message),
        Refused::Invalid(_) => api::error(StatusCode::BAD_REQUEST, message),
        Refused::Unavailable => api::error(StatusCode::INTERNAL_SERVER_ERROR, message),
    })
}

fn invalid(why: &str) -> JsonResponse {
    failure(&Refused::Invalid(why.to_owned()))
}

/// `{ items, next, revision }`: `limit` (100 unless asked) of the seller's listings after
/// `after`.
async fn show(State(db): State<Database>, Params(asked): Params<SlabInventory>) -> JsonResponse {
    // `Number(limit)`: anything but a whole number from 1 to 200 is refused as 0 is.
    let limit = asked
        .limit
        .first()
        .map_or(Some(100.0), |l| api::js_number(l))
        .filter(|l| l.fract() == 0.0 && (1.0..=200.0).contains(l))
        .map_or(0, |l| l as u32);
    let page = match db.0.acquire().await {
        Ok(mut conn) => {
            let first = |sent: &Vec<String>| sent.first().cloned().unwrap_or_default();
            let (seller, after) = (first(&asked.seller), first(&asked.after));
            inventory::answered_page(&mut conn, &seller, &after, limit).await
        }
        Err(error) => Err(error.to_string()),
    };
    match page {
        Ok(page) => unstored(api::node_json(&page)),
        // The page's own refusals are 400s; the database failing is not one of them.
        Err(why) if is_refusal(&why) => invalid(&why),
        Err(why) => failure(&unavailable(why)),
    }
}

/// Whether the inventory read refused the page, rather than failing.
fn is_refusal(why: &str) -> bool {
    [
        "Invalid inventory page.",
        "Enter the eBay seller username.",
        FIELDS,
    ]
    .contains(&why)
}

/// A post from a page of the app's own origin, read as `readSlabJsonRequest` reads it.
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
    let json = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    if !json.is_some_and(|t| t.starts_with("application/json")) {
        return invalid(FIELDS);
    }
    let Ok(body) = crate::api::body_up_to(body, MAX_BODY_BYTES).await else {
        return invalid(FIELDS);
    };
    let Ok(input) = serde_json::from_slice::<Value>(&body) else {
        return invalid(FIELDS);
    };
    match acted(&db, transport, &signal, &input).await {
        Ok(answer) => unstored(api::node_json(&answer)),
        Err(refused) => failure(&refused),
    }
}

/// `Number.isSafeInteger(value)`, as an integer.
fn safe_integer(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && n.abs() <= MOST_SAFE)
        .map(|n| n as i64)
}

fn unavailable(error: impl std::fmt::Display) -> Refused {
    eprintln!("slab inventory: {error}");
    Refused::Unavailable
}

/// The action, in the order Node checks: the seller, then the intent.
async fn acted(
    db: &Database,
    transport: Transport,
    signal: &Signal,
    input: &Value,
) -> Result<Value, Refused> {
    // `sellerAccount(input.seller)`: reading a field of `null` is a TypeError, and a seller
    // that is not text is refused as a field.
    let seller = match (input, &input["seller"]) {
        (Value::Null, _) => return Err(Refused::Invalid(FIELDS.to_owned())),
        (_, Value::Null) => "",
        (_, Value::String(seller)) => seller.as_str(),
        _ => return Err(Refused::Invalid(FIELDS.to_owned())),
    };
    let seller = inventory::seller_account(seller)?;
    let intent = input["intent"].as_str().unwrap_or_default();
    let text = |key: &str| input[key].as_str();
    if matches!(intent, "resolve-identity" | "assign-identity") {
        let id = text("id").unwrap_or_default();
        // Anything but a whole number from 1 is refused as revision 0 is.
        let revision = safe_integer(&input["revision"]).unwrap_or(0);
        if intent == "resolve-identity" {
            let resolved = resolve(db, transport, signal, &seller, id, revision).await?;
            return answered(db, resolved).await;
        }
        // A note that is not text is refused as an identity that is not one is.
        let identity = text("note").and(text("identityId")).unwrap_or_default();
        let note = text("note").unwrap_or_default();
        let mut conn = db.0.acquire().await.map_err(unavailable)?;
        inventory_import::assign(&mut conn, &seller, id, revision, identity, note).await?;
        return Ok(json!({ "ok": true }));
    }
    // Anything but a whole number from 0 is refused as -1 is.
    let revision = safe_integer(&input["revision"]).unwrap_or(-1);
    let now = chrono::Utc::now();
    let mut held = db.0.acquire().await.map_err(unavailable)?;
    let conn = &mut *held;
    let imported = match intent {
        "import-csv" => {
            inventory_import::current(conn, &seller, revision).await?;
            let Some(csv) = text("csv") else {
                return Err(Refused::Invalid("Provide inventory CSV text.".to_owned()));
            };
            inventory_import::import_csv(conn, &seller, revision, csv, now).await?
        }
        "import-manual" => {
            inventory_import::import_manual(conn, &seller, revision, &input["listings"], now)
                .await?
        }
        _ => {
            inventory_import::current(conn, &seller, revision).await?;
            return Err(Refused::Invalid(
                "Choose an inventory import or identity action.".to_owned(),
            ));
        }
    };
    let Imported { imported, revision } = imported;
    Ok(json!({ "imported": imported, "missing": 0, "revision": revision, "complete": false }))
}

/// Resolves the listing's certificate on a connection of its own while the request waits: the
/// client leaving cancels Alt's request, and the Alt connection's lease is released either way.
async fn resolve(
    db: &Database,
    transport: Transport,
    signal: &Signal,
    seller: &str,
    id: &str,
    revision: i64,
) -> Result<Resolved, Refused> {
    let (db, seller, id) = (db.clone(), seller.to_owned(), id.to_owned());
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
            inventory_import::resolve(&mut conn, &alt, &seller, &id, revision, cancel).await
        })
        .await
}

/// `{ identityId }` for a listing tied by hand, else `{ record, reviewReasons }`.
async fn answered(db: &Database, resolved: Resolved) -> Result<Value, Refused> {
    let reasons = resolved.review_reasons();
    let record = match resolved {
        Resolved::ByHand { identity_id } => return Ok(json!({ "identityId": identity_id })),
        Resolved::Looked { record, .. } => record,
    };
    let mut conn = db.0.acquire().await.map_err(unavailable)?;
    let stored = identity::answered(&mut conn, &record.id)
        .await
        .map_err(unavailable)?
        .ok_or(Refused::Unavailable)?;
    Ok(json!({ "record": stored, "reviewReasons": reasons }))
}

#[cfg(test)]
mod tests {
    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts slab-inventory`): an empty
    /// inventory, and every refusal before a write. What an import or identity change writes is
    /// compared with Node's in `inventory_import::tests`, and a page of listings in
    /// `inventory::tests`.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("slab-inventory", &[]).await;
    }
}
