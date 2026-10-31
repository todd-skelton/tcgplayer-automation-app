//! The slab evidence refresh worker, ported from `evidenceRefreshWorker.server.ts`: it claims the
//! next refresh due, reads it from its provider under a 60-second limit while checking every five
//! seconds that it still holds the lease, and saves what was read or the failure's code. A busy,
//! rate-limited or unavailable provider is tried again later; anything else fails the refresh.
//!
//! Node's worker refreshes the evidence until cutover, and also runs the slab maintenance cycle
//! when nothing is queued; that cycle is not ported. Node wakes its worker when a refresh is
//! requested; this one looks again within 30 seconds. Reading Alt and eBay is not ported, so the
//! app does not run this worker yet: [`run`] takes the [`Provider`] it reads with.
use std::{future::Future, time::Duration};

use corten::Signal;
use serde_json::Value;
use sqlx::PgConnection;
use tokio::{
    sync::Mutex,
    time::{Instant, interval_at, sleep},
};

use super::{
    spec::Spec,
    store::{self, Job},
};
use crate::{database::Database, features::slab_connections::ConnectionStatus as Status};

/// How long one read may take.
pub const TIMEOUT: Duration = Duration::from_secs(60);
/// How often a read checks that its refresh is still held.
const CHECK_EVERY: Duration = Duration::from_secs(5);
/// The pause after a refresh, when the next may be due at once.
const BUSY: Duration = Duration::from_secs(2);
/// The pause when nothing was due.
const IDLE: Duration = Duration::from_secs(30);
/// How often old evidence is cleaned.
const CLEAN_EVERY: Duration = Duration::from_secs(60 * 60);

/// What reads a request's evidence from its provider: the payload `{ kind, data }`, or the
/// status the provider left the connection in (`invalid-response` for an answer it could not
/// read).
pub trait Provider: Sync {
    fn fetch(&self, spec: &Spec) -> impl Future<Output = Result<Value, Status>> + Send;
}

/// The code a failure is saved under: a cancelled read counts as the provider being unavailable.
fn code(status: Status) -> Status {
    match status {
        Status::Cancelled => Status::Unavailable,
        status => status,
    }
}

/// Whether a refresh that failed so is tried again.
fn retried(code: Status) -> bool {
    matches!(
        code,
        Status::Busy | Status::RateLimited | Status::Unavailable
    )
}

/// `runEvidenceJob`: reads `job` with `provider` and saves what was read, or the failure. A read
/// still running when `stop` finishes, after [`TIMEOUT`], or once the lease is lost, fails as
/// `unavailable`. Answers whether evidence was saved.
pub async fn run_job(
    conn: &mut PgConnection,
    provider: &impl Provider,
    job: &Job,
    stop: impl Future<Output = ()>,
) -> Result<bool, store::Error> {
    let started = Instant::now();
    // One connection, taken in turn by the read and the lease check.
    let conn = Mutex::new(conn);
    let read = async {
        let active = store::active(&mut **conn.lock().await, job).await;
        match active {
            Ok(true) => provider.fetch(&job.spec).await.map(Some),
            Ok(false) => Ok(None),
            Err(_) => Err(Status::InvalidResponse),
        }
    };
    let lost = async {
        let mut every = interval_at(started + CHECK_EVERY, CHECK_EVERY);
        loop {
            every.tick().await;
            let active = store::active(&mut **conn.lock().await, job).await;
            if !matches!(active, Ok(true)) {
                return;
            }
        }
    };
    let read = tokio::select! {
        biased;
        _ = stop => Err(Status::Unavailable),
        _ = lost => Err(Status::Unavailable),
        _ = sleep(TIMEOUT) => Err(Status::Unavailable),
        read = read => read,
    };
    let conn = conn.into_inner();
    let failure = match read {
        Ok(None) => return Ok(false),
        Ok(Some(payload)) => {
            let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
            match store::complete(conn, job, &payload, duration_ms).await {
                Ok(saved) => return Ok(saved),
                Err(_) => Status::InvalidResponse,
            }
        }
        Err(status) => code(status),
    };
    store::fail(&mut *conn, job, failure.as_ref(), retried(failure)).await?;
    Ok(false)
}

/// One turn of the loop: the next refresh due, if any, then a clean when the last was an hour
/// ago. Answers the pause before the next turn.
#[expect(dead_code, reason = "run once reading Alt and eBay is ported")]
pub async fn tick(
    db: &Database,
    provider: &impl Provider,
    cleaned: &mut Option<Instant>,
    stop: impl Future<Output = ()>,
) -> Duration {
    let mut wait = IDLE;
    let turn = async {
        let mut conn = db.0.acquire().await?;
        if let Some(job) = store::claim(&mut conn).await? {
            wait = BUSY;
            run_job(&mut conn, provider, &job, stop).await?;
        }
        if cleaned.is_none_or(|at| at.elapsed() > CLEAN_EVERY) {
            store::clean(&mut conn).await?;
            *cleaned = Some(Instant::now());
        }
        Ok::<_, store::Error>(())
    };
    if let Err(why) = turn.await {
        eprintln!("Slab evidence worker refresh unavailable; retrying later: {why}");
    }
    wait
}

/// The app's task: a turn at once, then each after its pause, until shutdown. A read running at
/// shutdown is saved as unavailable, to be tried again.
#[expect(dead_code, reason = "run once reading Alt and eBay is ported")]
pub async fn run(db: Database, provider: impl Provider, signal: Signal) {
    println!("Slab evidence worker started");
    let mut cleaned = None;
    while !signal.is_aborted() {
        let wait = tick(&db, &provider, &mut cleaned, async {
            signal.aborted().await;
        })
        .await;
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = sleep(wait) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sqlx::Connection;

    use super::*;
    use crate::features::slab_evidence::spec::{EbayPage, Window};

    #[test]
    fn busy_rate_limited_and_unavailable_providers_are_tried_again() {
        assert_eq!(code(Status::Cancelled), Status::Unavailable);
        assert!(retried(Status::Busy));
        assert!(retried(Status::RateLimited));
        assert!(retried(code(Status::Cancelled)));
        assert!(!retried(Status::InvalidResponse));
        assert!(!retried(Status::ReconnectRequired));
    }

    /// The answers of `.port-logs/slab-worker-node.ts`'s stand-in fetch: no provider is called.
    struct StandIn(Value);

    impl Provider for StandIn {
        fn fetch(&self, spec: &Spec) -> impl Future<Output = Result<Value, Status>> + Send {
            let answer = match spec {
                Spec::AltSaleDetail { transaction_id } if transaction_id == "tx-9" => {
                    Some(Ok(self.0["detail"].clone()))
                }
                Spec::AltSales { .. } => Some(Ok(self.0["sales"].clone())),
                Spec::EbaySales(_) => Some(Err(Status::RateLimited)),
                Spec::EbaySupply(_) => Some(Err(Status::Cancelled)),
                _ => None,
            };
            async move {
                match answer {
                    Some(answer) => answer,
                    None => std::future::pending().await,
                }
            }
        }
    }

    fn without_durations(mut captured: Value) -> Value {
        for refresh in captured["refreshes"].as_array_mut().unwrap() {
            refresh.as_object_mut().unwrap().remove("duration");
        }
        captured
    }

    /// Six refreshes (two saved, one refused for the wrong asset, a rate limit, a cancelled read
    /// and one that never answers) run on the dev database in a transaction rolled back, compared
    /// with what Node's `runEvidenceJob` answered and wrote. How long each read took differs.
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn refreshes_run_as_node_runs_them() {
        crate::config::load_env();
        let read = |path: &str| std::fs::read_to_string(path).unwrap();
        let node: Value = serde_json::from_str(&read(".port-logs/slab-worker.node.json")).unwrap();
        let scenario: Value =
            serde_json::from_str(&read(".port-logs/slab-evidence-scenario.json")).unwrap();
        let capture = read(".port-logs/slab-evidence-capture.sql");
        let window = Window {
            from: "2025-10-30".into(),
            to: "2026-10-30".into(),
        };
        let ebay = |offset| EbayPage {
            group_key: "ab".repeat(32),
            keywords: "PSA 10 Charizard Base Set".into(),
            window: window.clone(),
            offset,
            limit: 50,
            timezone: "America/Chicago".into(),
        };
        let alt_sales = |asset: &str| Spec::AltSales {
            asset_id: asset.into(),
            window: window.clone(),
            limit_per_grade: 16,
        };
        let detail = |transaction: &str| Spec::AltSaleDetail {
            transaction_id: transaction.into(),
        };
        let specs = vec![
            detail("tx-9"),
            alt_sales("asset-1"),
            Spec::EbaySales(ebay(0)),
            Spec::EbaySupply(ebay(50)),
            alt_sales("asset-2"),
            detail("tx-10"),
        ];
        let provider = StandIn(scenario);
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        // The queue's tests write the same keys: one at a time, or their transactions deadlock.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('slab_evidence_refreshes tests'))")
            .execute(&mut *tx)
            .await
            .unwrap();
        store::request(&mut tx, &specs, false, 200).await.unwrap();
        let mut steps = Vec::new();
        while let Some(job) = store::claim(&mut tx).await.unwrap() {
            let saved = run_job(&mut tx, &provider, &job, sleep(Duration::from_millis(300)))
                .await
                .unwrap();
            steps.push(json!({ "key": job.key, "kind": job.spec.kind(), "saved": saved }));
        }
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let captured: Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(Value::Array(steps), node["steps"]);
        assert_eq!(
            without_durations(captured),
            without_durations(node["captured"].clone())
        );
    }
}
