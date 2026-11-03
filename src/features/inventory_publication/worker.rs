//! The publication worker's loop (`inventoryPublicationWorker.server.ts`'s tick): the
//! publications a lost worker left put right, then, unless publishing is paused, its circuit
//! open or Seller Portal's sign-in refused, the next queued intake planned and the oldest planned
//! publication claimed and published while its lease is renewed.
//!
//! Node's worker publishes until cutover: this one runs only when `PUBLICATION_WORKER` is set,
//! and then writes to Seller Portal for real. The two claim from one queue under their own
//! leases. A publication in Seller Portal's hands is not stopped at shutdown: one cut off there
//! is left to its lease, and reconciled as ambiguous like a crashed worker's.
use std::time::Duration;

use chrono::{DateTime, Utc};
use corten::Signal;
use serde_json::Value;
use sqlx::PgConnection;
use tokio::time::{MissedTickBehavior, interval, sleep};

use super::{
    execution, queued_intake,
    seller_portal::{Live, Poster},
    store::{self, Publication},
};
use crate::{database::Database, features::publication_configuration::config::Settings};

/// How long a claim lasts unless renewed.
pub const LEASE: Duration = Duration::from_millis(30_000);
/// How often a publication in progress renews its claim.
const HEARTBEAT: Duration = Duration::from_millis(5_000);
/// How often the queue is looked at again when nothing was published.
const POLL: Duration = Duration::from_millis(1_000);

/// Whether `PUBLICATION_WORKER` turns the worker on. It stays off without Seller Portal writes,
/// so planned publications wait for a process that may send them.
pub fn on() -> bool {
    let wanted = crate::config::is_set("PUBLICATION_WORKER");
    if wanted && !crate::config::seller_portal_writes() {
        eprintln!(
            "Inventory publication worker is off: PUBLICATION_WORKER is set but {} is not true",
            crate::config::SELLER_PORTAL_WRITES
        );
        return false;
    }
    wanted
}

pub fn worker_id() -> String {
    format!("inventory-publication-worker-rust-{}", std::process::id())
}

fn lease_ms() -> i64 {
    LEASE.as_millis() as i64
}

/// Why a turn claimed nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Idle {
    /// Publishing is paused, its circuit open, or Seller Portal refused the sign-in.
    Stopped,
    NothingPlanned,
}

/// The first part of a turn: recovery, the settings' say, the next queued intake planned, and
/// the oldest planned publication claimed for `worker`.
pub async fn claim(
    conn: &mut PgConnection,
    worker: &str,
    now: DateTime<Utc>,
) -> Result<Result<Publication, Idle>, store::Error> {
    store::recover_saved_outcomes(conn).await?;
    store::recover_expired_claims(conn).await?;
    let (stored, authentication, circuit_open): (Value, String, bool) = sqlx::query_as(
        "SELECT settings_json, authentication_status, circuit_open
         FROM inventory_publication_settings WHERE config_key = 'default'",
    )
    .fetch_optional(&mut *conn)
    .await?
    .unwrap_or_else(|| (Value::Null, "unknown".into(), false));
    if Settings::of(&stored).global_paused || circuit_open || authentication == "invalid" {
        return Ok(Err(Idle::Stopped));
    }
    if let Err(why) = queued_intake::plan_next(conn, now).await {
        eprintln!(
            "Queued intake publication planning failed; existing publications can continue: {why}"
        );
    }
    Ok(store::claim_next(conn, worker, lease_ms())
        .await?
        .ok_or(Idle::NothingPlanned))
}

/// Publishes the claimed publication on `conn` while renewing its claim on another connection.
async fn process(
    db: &Database,
    conn: &mut PgConnection,
    portal: &impl Poster,
    publication: &Publication,
    worker: &str,
) -> Result<(), store::Error> {
    let renew = async {
        let mut beat = interval(HEARTBEAT);
        beat.set_missed_tick_behavior(MissedTickBehavior::Delay);
        beat.tick().await; // the first tick is at once; the claim was just made
        loop {
            beat.tick().await;
            let renewed = async {
                let mut conn = db.0.acquire().await?;
                store::heartbeat(&mut conn, publication.id, worker, lease_ms()).await
            };
            if let Err(why) = renewed.await {
                eprintln!("Inventory publication heartbeat failed: {why}");
            }
        }
    };
    tokio::select! {
        done = execution::run_claimed(conn, portal, publication, worker) => done,
        never = renew => never,
    }
}

/// One turn. Answers the pause before the next: none after a publication, the poll otherwise.
pub async fn tick(db: &Database, portal: &impl Poster, worker: &str) -> Duration {
    let turn = async {
        let mut conn = db.0.acquire().await?;
        match claim(&mut conn, worker, Utc::now()).await? {
            Ok(publication) => {
                process(db, &mut conn, portal, &publication, worker).await?;
                Ok(Duration::ZERO)
            }
            Err(_) => Ok(POLL),
        }
    };
    match turn.await {
        Ok(wait) => wait,
        Err(why) => {
            let why: store::Error = why;
            eprintln!("Inventory publication worker failed: {why}");
            POLL
        }
    }
}

/// The app's task: turns until shutdown, publishing to Seller Portal itself.
pub async fn run(db: Database, signal: Signal) {
    let portal = Live(crate::tcgplayer::TcgPlayer::new(db.clone()));
    let worker = worker_id();
    println!("Inventory publication worker {worker} started");
    while !signal.is_aborted() {
        let wait = tick(&db, &portal, &worker).await;
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = sleep(wait) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, future::Future, sync::Mutex};

    use regex::Regex;
    use serde_json::{Value, json};
    use sqlx::Connection;

    use super::*;
    use crate::features::inventory_publication::seller_portal::{Answer, Unsuccessful};

    /// Seller Portal as `.port-logs/pubworker-node.ts` stands it in: each post answered with the
    /// case's next scripted answer (`$rows` the rows the post carried, `$uploaded` every SKU
    /// uploaded so far, published) and its form recorded.
    struct StandIn {
        answers: Mutex<VecDeque<Value>>,
        uploaded: Mutex<Vec<i64>>,
        calls: Mutex<Vec<Value>>,
    }

    fn resolve(value: &Value, rows: usize, uploaded: &[i64]) -> Value {
        match value {
            Value::String(s) if s == "$rows" => json!(rows),
            Value::String(s) if s == "$uploaded" => uploaded
                .iter()
                .map(|sku| json!({ "ProductConditionId": sku, "Message": null }))
                .collect(),
            Value::Array(values) => values.iter().map(|v| resolve(v, rows, uploaded)).collect(),
            Value::Object(fields) => fields
                .iter()
                .map(|(k, v)| (k.clone(), resolve(v, rows, uploaded)))
                .collect(),
            other => other.clone(),
        }
    }

    fn answer(stored: &Value, data: Value) -> Answer {
        Answer {
            status: stored["status"].as_u64().unwrap() as u16,
            content_type: stored["contentType"].as_str().map(str::to_owned),
            redirected: stored["redirected"].as_bool(),
            data,
        }
    }

    impl Poster for StandIn {
        fn post(
            &self,
            path: &str,
            form: &str,
        ) -> impl Future<Output = Result<Answer, Unsuccessful>> + Send {
            let file = Regex::new(r"inventory-publication-\d+\.csv").unwrap();
            let row = Regex::new(r"^data\[\d+\]\[ProductConditionId\]$").unwrap();
            self.calls.lock().unwrap().push(json!({
                "path": path,
                "form": file.replace_all(form, "inventory-publication-ID.csv"),
            }));
            let skus: Vec<i64> = form_urlencoded::parse(form.as_bytes())
                .filter(|(name, _)| row.is_match(name))
                .map(|(_, sku)| sku.parse().unwrap())
                .collect();
            let mut uploaded = self.uploaded.lock().unwrap();
            uploaded.extend(&skus);
            let scripted = self.answers.lock().unwrap().pop_front().unwrap_or_else(|| {
                json!({ "error": { "message": "The stand-in has no answer.", "code": null, "response": null } })
            });
            let result = match scripted.get("ok") {
                Some(ok) => Ok(answer(ok, resolve(&ok["data"], skus.len(), &uploaded))),
                None => {
                    let error = &scripted["error"];
                    Err(Unsuccessful {
                        message: error["message"].as_str().unwrap().into(),
                        code: error["code"].as_str().map(str::to_owned),
                        answer: error["response"]
                            .as_object()
                            .map(|_| answer(&error["response"], error["response"]["data"].clone())),
                    })
                }
            };
            async move { result }
        }
    }

    const WORKER: &str = "port-worker";

    /// A turn of Node's tick as the recorder writes it.
    async fn turn(conn: &mut PgConnection, portal: &StandIn) -> String {
        let claimed = match claim(conn, WORKER, Utc::now()).await {
            Ok(Ok(publication)) => publication,
            Ok(Err(Idle::Stopped)) => return "stopped".into(),
            Ok(Err(Idle::NothingPlanned)) => return "nothing planned".into(),
            Err(why) => return format!("failed: {why}"),
        };
        let key: String =
            sqlx::query_scalar("SELECT planning_key FROM inventory_publications WHERE id = $1")
                .bind(claimed.id)
                .fetch_one(&mut *conn)
                .await
                .unwrap();
        let selection = Regex::new(r"^inventory-batch-pricing-job:(\d+):selection:.*$").unwrap();
        let key = selection.replace(&key, "inventory-batch-pricing-job:$1:selection");
        match execution::run_claimed(conn, portal, &claimed, WORKER).await {
            Ok(()) => format!("published {key}"),
            Err(why) => format!("failed: {why}"),
        }
    }

    /// The cases in `.port-logs/pubworker-cases.json` on the dev database, a turn at a time
    /// against Seller Portal stood in, in one transaction rolled back (a savepoint each): the
    /// turns, the forms posted and everything written as Node's worker did
    /// (`.port-logs/pubworker-node.ts`). Received inventory planned from its intake run and made
    /// live; a continuous publication's refused row, warning, error and missing outcome; a
    /// refused sign-in, a refused upload, a partial one whose rollback fails, a failed move to
    /// live, a refused finalize and an unreadable upload id; lost workers' publications put
    /// right; intake runs left for review; a direct publication.
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn turns_run_as_node_runs_them() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Vec<Value> = serde_json::from_str(&read("pubworker.node.json")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(&read("pubworker-cases.json")).unwrap();
        let capture = read("pubworker-capture.sql");
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::raw_sql(&read("pubworker-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(cases.len(), node.len());
        for (case, theirs) in cases.iter().zip(&node) {
            let name = case["name"].as_str().unwrap();
            let mut savepoint = tx.begin().await.unwrap();
            sqlx::raw_sql(case["setup"].as_str().unwrap())
                .execute(&mut *savepoint)
                .await
                .unwrap();
            let portal = StandIn {
                answers: Mutex::new(case["portal"].as_array().unwrap().iter().cloned().collect()),
                uploaded: Mutex::default(),
                calls: Mutex::default(),
            };
            let mut turns = Vec::new();
            for _ in 0..case["steps"].as_u64().unwrap() {
                turns.push(turn(&mut savepoint, &portal).await);
            }
            let captured: String = sqlx::query_scalar(&capture)
                .fetch_one(&mut *savepoint)
                .await
                .unwrap();
            savepoint.rollback().await.unwrap();
            let ours = json!({
                "turns": turns,
                "calls": *portal.calls.lock().unwrap(),
                "left": portal.answers.lock().unwrap().len(),
                "captured": serde_json::from_str::<Value>(&captured).unwrap(),
            });
            for part in ["turns", "calls", "left"] {
                assert_eq!(ours[part], theirs[part], "{name}: {part}");
            }
            for (part, value) in theirs["captured"].as_object().unwrap() {
                assert_eq!(&ours["captured"][part], value, "{name}: {part}");
            }
        }
        tx.rollback().await.unwrap();
    }
}
