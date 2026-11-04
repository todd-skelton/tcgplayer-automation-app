//! `POST /api/inventory-opening-balance`: an operator's opening balance actions for the configured
//! seller, as the Node route answered them. Its four pages (an observation's differences and
//! items, a run's application differences and preview items) are read here, a difference is
//! acknowledged here, an observation is previewed as a run here, and so are capturing an
//! observation and applying a run, which read the seller's inventory from Seller Portal and (to
//! apply) move the order history on (`capture`, `apply`).
use corten::{
    Api, JsonResponse, Prefix,
    axum::{body::to_bytes, extract::Request, http::StatusCode},
    prelude::*,
};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::{
    acknowledgement::{self, Acknowledgement},
    apply::{self, Application, OrderHistory, TcgPlayerOrders},
    capture::{self, Capture, Portal, SellerPortal},
    pages, preview,
};
use crate::{
    api, app::Shared, database::Database, features::shipping_configuration, node_pg,
    tcgplayer::TcgPlayer,
};

/// The largest body read: an action and its IDs.
const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Route)]
#[route("/api/inventory-opening-balance")]
pub struct InventoryOpeningBalance;

/// The route, added to the app's one API at `/api` (`crate::api`).
pub fn routes<P: Prefix>(api: Api<P>, shared: &Shared) -> Api<P> {
    api.route::<InventoryOpeningBalance>(post(act).with_state(shared.clone()))
}

/// What reads TCGplayer for an action: Seller Portal for an observation, the order history's
/// scan before an application.
pub trait Live: Portal + OrderHistory {}

impl<T: Portal + OrderHistory> Live for T {}

/// TCGplayer itself.
struct Tcg<'a>(&'a TcgPlayer);

impl Portal for Tcg<'_> {
    async fn pricing_context(&self) -> Result<String, String> {
        SellerPortal(self.0).pricing_context().await
    }

    async fn export(&self) -> Result<String, String> {
        SellerPortal(self.0).export().await
    }
}

impl OrderHistory for Tcg<'_> {
    async fn catch_up(&self, conn: &mut PgConnection, seller: &str) -> Result<(), String> {
        TcgPlayerOrders(self.0).catch_up(conn, seller).await
    }
}

/// Why a request was refused: Node's status and message.
type Refused = (StatusCode, String);

/// The action's answer, or its refusal as Node's status and message.
async fn act(State(db): State<Database>, request: Request) -> JsonResponse {
    let body = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => return api::error(StatusCode::CONFLICT, format!("Error: {error}")),
    };
    let mut conn = match db.0.acquire().await {
        Ok(conn) => conn,
        Err(error) => return api::error(StatusCode::CONFLICT, node_pg::thrown(error)),
    };
    let tcgplayer = TcgPlayer::new(db.clone());
    match acted(&db, &mut conn, &body, &Tcg(&tcgplayer)).await {
        Ok(answer) => api::node_json(&answer),
        Err((status, message)) => api::error(status, message),
    }
}

/// The action `body` asks for, its pages read and its writes made on `conn`, for the seller
/// configured in `db`, TCGplayer read through `live`.
async fn acted(
    db: &Database,
    conn: &mut PgConnection,
    body: &[u8],
    live: &impl Live,
) -> Result<Value, Refused> {
    let failed = |message: String| (StatusCode::CONFLICT, message);
    let bad = |message: &str| (StatusCode::BAD_REQUEST, message.to_owned());
    let payload: Value =
        serde_json::from_slice(body).map_err(|e| failed(format!("SyntaxError: {e}")))?;
    let text = |key: &str| payload.get(key).and_then(Value::as_str);
    let configured = shipping_configuration::default_seller_key(db)
        .await
        .map_err(|e| failed(format!("Error: {e}")))?;
    if payload.is_null() {
        let message = "TypeError: Cannot read properties of null (reading 'sellerKey')";
        return Err(failed(message.into()));
    }
    let configured = api::js_trim(&configured);
    let seller = text("sellerKey").map_or(configured, api::js_trim);
    if seller.is_empty() || seller != configured {
        return Err(bad("Seller key must match the configured seller."));
    }
    let number = |key: &str| payload.get(key).and_then(Value::as_f64);
    let answer = match text("action") {
        Some("capture") => {
            let request_id = text("requestId").ok_or_else(|| bad("Request ID is required."))?;
            let input = Capture {
                request_id,
                seller,
                purpose: None,
            };
            let observation = capture::capture(conn, live, &input, &capture::now_ms);
            json!({ "observation": observation.await.map_err(failed)? })
        }
        Some("apply") => {
            let (Some(request_id), Some(run_id), Some(evidence_fingerprint)) = (
                text("requestId"),
                text("runId"),
                text("evidenceFingerprint"),
            ) else {
                return Err(bad(
                    "Request ID, run ID, and evidence fingerprint are required.",
                ));
            };
            let input = Application {
                request_id,
                run_id,
                evidence_fingerprint,
                seller,
            };
            let result = apply::apply(conn, live, live, &input, &capture::now_ms);
            json!({ "result": result.await.map_err(failed)? })
        }
        Some("list_differences") => {
            let observation =
                text("observationId").ok_or_else(|| bad("Observation ID is required."))?;
            let page = pages::differences(
                &mut *conn,
                seller,
                observation,
                text("afterId"),
                number("limit"),
            );
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_application_differences") => {
            let (Some(run), Some(validation)) = (text("runId"), text("validationObservationId"))
            else {
                return Err(bad("Run and validation observation IDs are required."));
            };
            let (after, limit) = (text("afterId"), number("limit"));
            let page =
                pages::application_differences(&mut *conn, seller, run, validation, after, limit);
            json!({ "differences": page.await.map_err(failed)? })
        }
        Some("list_observation_items") => {
            let observation =
                text("observationId").ok_or_else(|| bad("Observation ID is required."))?;
            let (after, limit) = (text("afterInventoryKey"), number("limit"));
            let unsupported_only = payload.get("unsupportedOnly").and_then(Value::as_bool);
            let page = pages::observation_items(
                &mut *conn,
                seller,
                observation,
                after,
                limit,
                unsupported_only,
            );
            json!({ "items": page.await.map_err(failed)? })
        }
        Some("acknowledge_difference") => {
            let (Some(request_id), Some(difference_id), Some(note)) =
                (text("requestId"), text("differenceId"), text("note"))
            else {
                return Err(bad(
                    "Request ID, difference ID, and acknowledgement note are required.",
                ));
            };
            let input = Acknowledgement {
                request_id,
                difference_id,
                seller,
                note,
            };
            json!({ "result": acknowledgement::acknowledge(conn, &input).await.map_err(failed)? })
        }
        Some("preview") => {
            let (Some(request_id), Some(observation_id)) =
                (text("requestId"), text("observationId"))
            else {
                return Err(bad("Request and observation IDs are required."));
            };
            let preview = preview::preview(conn, request_id, seller, observation_id);
            json!({ "preview": preview.await.map_err(failed)? })
        }
        Some("list_preview_items") => {
            let run = text("runId").ok_or_else(|| bad("Run ID is required."))?;
            let page =
                pages::preview_items(&mut *conn, seller, run, number("afterSku"), number("limit"));
            json!({ "items": page.await.map_err(failed)? })
        }
        _ => return Err(bad("Unknown opening balance action.")),
    };
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use serde_json::Value;
    use sqlx::Connection;

    use sqlx::PgConnection;

    use super::acted;
    use crate::{
        database::Database,
        features::inventory_opening_balance::{apply::OrderHistory, capture::Portal},
    };

    /// TCGplayer for the actions that never read it: any read fails.
    struct Offline;

    impl Portal for Offline {
        async fn pricing_context(&self) -> Result<String, String> {
            Err("Error: offline".into())
        }
        async fn export(&self) -> Result<String, String> {
            Err("Error: offline".into())
        }
    }

    impl OrderHistory for Offline {
        async fn catch_up(&self, _: &mut PgConnection, _: &str) -> Result<(), String> {
            Err("Error: offline".into())
        }
    }

    /// The acknowledgements in `.port-logs/opening-ack-cases.json` from its seeded differences, on
    /// the dev database in a transaction rolled back (a savepoint each), against Node's action
    /// over the same (`.port-logs/opening-ack-node.ts`): each answer and the differences left.
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn acknowledgements_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let recorded: Value = serde_json::from_str(&read_log("opening-ack-cases.json")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read_log("opening-ack.node.json")).unwrap();
        let capture = read_log("opening-ack-capture.sql");
        let cases = recorded["cases"].as_array().unwrap();
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(recorded["seed"].as_str().unwrap())
            .execute(&mut *tx)
            .await
            .unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let mut each = tx.begin().await.unwrap();
            let mut answers = Vec::new();
            for body in case["steps"].as_array().unwrap() {
                let body = body.as_str().unwrap().as_bytes();
                answers.push(match acted(&db, &mut each, body, &Offline).await {
                    Ok(answer) => serde_json::json!({ "status": 200, "body": answer }),
                    Err((status, error)) => serde_json::json!({
                        "status": status.as_u16(),
                        "body": { "error": error },
                    }),
                });
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(Value::from(answers), theirs["answers"], "{name}");
            let captured: Value = serde_json::from_str(&captured).unwrap();
            assert_eq!(captured, theirs["captured"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// The previews in `.port-logs/opening-preview-cases.json` (each case's `setup` first) on the
    /// dev database's observations, in a transaction rolled back (a savepoint each), against
    /// Node's action over the same (`.port-logs/opening-preview-node.ts`): each answer, a run it
    /// made named by its order (`RUN1`), and the runs and items each case left
    /// (`.port-logs/opening-preview-capture.sql`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn previews_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(&read_log("opening-preview-cases.json")).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log("opening-preview.node.json")).unwrap();
        let capture = read_log("opening-preview-capture.sql");
        assert_eq!(cases.len(), node.len());
        let mut tx = db.0.begin().await.unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let mut each = tx.begin().await.unwrap();
            if let Some(setup) = case["setup"].as_str() {
                sqlx::raw_sql(setup).execute(&mut *each).await.unwrap();
            }
            let mut answers = Vec::new();
            for body in case["steps"].as_array().unwrap() {
                let body = body.as_str().unwrap().as_bytes();
                let mut attempt = each.begin().await.unwrap();
                let answer = acted(&db, &mut attempt, body, &Offline).await;
                match answer {
                    Ok(_) => attempt.commit().await.unwrap(),
                    Err(_) => attempt.rollback().await.unwrap(),
                }
                let runs: Vec<String> = sqlx::query_scalar(
                    "SELECT id::text FROM inventory_opening_balance_runs WHERE created_at=now() ORDER BY id",
                )
                .fetch_all(&mut *each)
                .await
                .unwrap();
                answers.push(match answer {
                    Ok(mut answer) => {
                        let id = &mut answer["preview"]["id"];
                        if let Some(n) = runs.iter().position(|r| Some(r.as_str()) == id.as_str()) {
                            *id = Value::from(format!("RUN{}", n + 1));
                        }
                        serde_json::json!({ "status": 200, "body": crate::api::tests::node_numbers(&answer) })
                    }
                    Err((status, error)) => serde_json::json!({
                        "status": status.as_u16(),
                        "body": { "error": error },
                    }),
                });
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            let node_answers = theirs["answers"].as_array().unwrap();
            assert_eq!(answers.len(), node_answers.len(), "{name}");
            for (ours, expected) in answers.iter().zip(node_answers) {
                if case["syntax"] == true {
                    assert_eq!(ours["status"], expected["status"], "{name}");
                } else {
                    assert_eq!(*ours, *expected, "{name}");
                }
            }
            let captured: Value = serde_json::from_str(&captured).unwrap();
            assert_eq!(captured, theirs["captured"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// Seller Portal's pages and exports as a case lists them, in order (the last page kept), and
    /// an order history scan that records a complete sync run unless told to skip it.
    struct Recorded {
        contexts: std::sync::Mutex<Vec<String>>,
        exports: std::sync::Mutex<std::collections::VecDeque<String>>,
        coverage: String,
        skip_coverage: std::sync::atomic::AtomicBool,
    }

    impl Portal for Recorded {
        async fn pricing_context(&self) -> Result<String, String> {
            let mut pages = self.contexts.lock().unwrap();
            match pages.len() {
                0 => Err("Error: no page".into()),
                1 => Ok(pages[0].clone()),
                _ => Ok(pages.remove(0)),
            }
        }
        async fn export(&self) -> Result<String, String> {
            let next = self.exports.lock().unwrap().pop_front();
            next.ok_or_else(|| "Error: no export".into())
        }
    }

    impl OrderHistory for Recorded {
        async fn catch_up(&self, conn: &mut PgConnection, _: &str) -> Result<(), String> {
            if !self.skip_coverage.load(std::sync::atomic::Ordering::SeqCst) {
                sqlx::raw_sql(&self.coverage)
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }

    /// The id's rank among the case's, as `OBS1` or `RUN1`.
    fn rank(list: &mut Vec<String>, id: &str, prefix: &str) -> String {
        if !list.iter().any(|known| known == id) {
            list.push(id.to_owned());
        }
        let at = list.iter().position(|known| known == id).unwrap();
        format!("{prefix}{}", at + 1)
    }

    /// An answer as `opening-capture-node.ts` normalizes Node's.
    fn normalized(value: &Value, observations: &mut Vec<String>) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|v| normalized(v, observations)).collect())
            }
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .map(|(key, v)| {
                        let v = match (key.as_str(), v.as_str()) {
                            ("observationId" | "validationObservationId", Some(id)) => {
                                Value::from(rank(observations, id, "OBS"))
                            }
                            ("cutoffAt", Some(_)) => Value::from("TIME"),
                            ("evidenceFingerprint", Some(_)) => Value::from("FP"),
                            _ => normalized(v, observations),
                        };
                        (key.clone(), v)
                    })
                    .collect(),
            ),
            Value::String(text) => {
                let numbered = regex::Regex::new(r"observation \d+").unwrap();
                Value::from(numbered.replace_all(text, "observation N").into_owned())
            }
            other => other.clone(),
        }
    }

    /// The captures and applications in `.port-logs/opening-capture-cases.json` on the dev
    /// database in a transaction rolled back (a savepoint each case, its setup first), Seller
    /// Portal and the order scan as the case records them, against Node's action over the same
    /// (`.port-logs/opening-capture-node.ts`): each answer normalized, and what each case left
    /// (`.port-logs/opening-capture-capture.sql`).
    #[tokio::test]
    #[ignore = "uses the dev database in a transaction rolled back, and Node's answers in .port-logs"]
    async fn captures_and_applications_answer_as_node_answered() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(&read_log("opening-capture-cases.json")).unwrap();
        let node: Vec<Value> =
            serde_json::from_str(&read_log("opening-capture.node.json")).unwrap();
        let capture = read_log("opening-capture-capture.sql");
        assert_eq!(cases.len(), node.len());
        let coverage = cases[0]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|s| s["sql"].as_str())
            .unwrap()
            .to_owned();
        let mut tx = db.0.begin().await.unwrap();
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let texts = |key: &str| -> Vec<String> {
                case[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_owned())
                    .collect()
            };
            let live = Recorded {
                contexts: std::sync::Mutex::new(texts("contexts")),
                exports: std::sync::Mutex::new(texts("exports").into()),
                coverage: coverage.clone(),
                skip_coverage: false.into(),
            };
            let mut each = tx.begin().await.unwrap();
            if let Some(setup) = case["setup"].as_str() {
                sqlx::raw_sql(setup).execute(&mut *each).await.unwrap();
            }
            let (mut observations, mut runs) = (Vec::new(), Vec::new());
            let (mut last_observation, mut last_run, mut last_fingerprint) =
                (String::new(), String::new(), String::new());
            let mut answers = Vec::new();
            for step in case["steps"].as_array().unwrap() {
                if let Some(sql) = step["sql"].as_str() {
                    sqlx::raw_sql(sql).execute(&mut *each).await.unwrap();
                    answers.push(serde_json::json!({ "sql": true }));
                    continue;
                }
                let body = step
                    .as_str()
                    .unwrap()
                    .replace("{{observation}}", &last_observation)
                    .replace("{{run}}", &last_run)
                    .replace("{{fingerprint}}", &last_fingerprint);
                let skip = serde_json::from_str::<Value>(&body).unwrap()["skipCoverage"] == true;
                live.skip_coverage
                    .store(skip, std::sync::atomic::Ordering::SeqCst);
                let mut attempt = each.begin().await.unwrap();
                let answer = acted(&db, &mut attempt, body.as_bytes(), &live).await;
                match answer {
                    Ok(_) => attempt.commit().await.unwrap(),
                    Err(_) => attempt.rollback().await.unwrap(),
                }
                answers.push(match answer {
                    Ok(mut answer) => {
                        if let Some(id) = answer["observation"]["id"].as_str().map(str::to_owned) {
                            answer["observation"]["id"] = rank(&mut observations, &id, "OBS").into();
                            last_observation = id;
                        }
                        if let Some(id) = answer["preview"]["id"].as_str().map(str::to_owned) {
                            last_fingerprint = answer["preview"]["evidenceFingerprint"]
                                .as_str()
                                .unwrap()
                                .to_owned();
                            answer["preview"]["id"] = rank(&mut runs, &id, "RUN").into();
                            last_run = id;
                        }
                        if let Some(id) = answer["result"]["id"].as_str().map(str::to_owned) {
                            answer["result"]["id"] = rank(&mut runs, &id, "RUN").into();
                        }
                        let answer = crate::api::tests::node_numbers(&answer);
                        serde_json::json!({ "status": 200, "body": normalized(&answer, &mut observations) })
                    }
                    Err((status, error)) => serde_json::json!({
                        "status": status.as_u16(),
                        "body": normalized(&serde_json::json!({ "error": error }), &mut observations),
                    }),
                });
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *each)
                .await
                .unwrap();
            each.rollback().await.unwrap();
            assert_eq!(Value::from(answers), theirs["answers"], "{name}");
            let captured: Value = serde_json::from_str(&captured).unwrap();
            assert_eq!(captured, theirs["captured"], "{name}");
        }
        tx.rollback().await.unwrap();
    }

    /// Node's answers on the dev database (`scripts/parity/record-node-answers.ts inventory-opening-balance`):
    /// each page as the dev seller's observations and run have them, and every refusal.
    #[tokio::test]
    #[ignore = "reads the dev database, and Node's answers in tests/fixtures/node"]
    async fn the_route_answers_as_node_answered() {
        crate::api::tests::answers_as_node("inventory-opening-balance", &[]).await;
    }
}
