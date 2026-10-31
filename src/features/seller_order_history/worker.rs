//! The seller order history worker, ported from `seller-order-history-worker.server.ts`. A cycle
//! takes a step of the order sync when one is due, replays up to [`REPLAYS`] queued FIFO SKUs,
//! and estimates the purchase cost of batches still uncosted; it runs again at once while either
//! is behind, otherwise within a minute.
//!
//! Node's worker records the history until cutover (port decisions 3 and 26): this one runs only
//! when `SELLER_ORDER_HISTORY_WORKER` is set. Beside Node's, the two share the sync run's claim,
//! the replay queue's and the estimates' locks, so either may take any step.
use std::time::Duration;

use corten::Signal;
use sqlx::PgConnection;
use tokio::time::{Instant, sleep};

use super::{
    api::OrderManagement,
    store::Postgres,
    sync::{self, Budget, Coverage, Orders},
};
use crate::{
    database::Database,
    features::{inventory_economics::estimate, inventory_fifo::queue, shipping_configuration},
    tcgplayer::TcgPlayer,
};

/// Orders change through their status, which the search shows, so an hourly look is enough.
pub const SYNC_EVERY: Duration = Duration::from_secs(60 * 60);
/// The FIFO SKUs a cycle replays at most.
pub const REPLAYS: usize = 25;
const IDLE: Duration = Duration::from_secs(60);
const BEHIND: Duration = Duration::from_secs(2);

/// Whether `SELLER_ORDER_HISTORY_WORKER` turns the worker on.
pub fn on() -> bool {
    crate::config::is_set("SELLER_ORDER_HISTORY_WORKER")
}

/// What a cycle did.
#[derive(Debug)]
pub struct Cycle {
    /// The sync step's coverage, when a step was due.
    pub synced: Option<Result<Coverage, String>>,
    pub replays: Result<usize, String>,
    pub estimated: Result<Vec<i32>, String>,
}

fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One cycle for `seller` on `conn`, each write in a transaction of its own (a savepoint when
/// `conn` is already in one); the sync step only when `sync_due`.
pub async fn cycle(
    conn: &mut PgConnection,
    orders: &impl Orders,
    seller: &str,
    sync_due: bool,
    claim: &str,
    now: &(dyn Fn() -> String + Sync),
) -> Cycle {
    let synced = if sync_due {
        let store = Postgres::new(&mut *conn);
        Some(
            sync::synchronize(orders, &store, seller, Budget::default(), &[], claim, now)
                .await
                .map(|synced| synced.coverage),
        )
    } else {
        None
    };
    let mut replays = 0;
    let replayed = loop {
        if replays == REPLAYS {
            break Ok(replays);
        }
        match queue::process_next(conn, seller).await {
            Ok(Some(_)) => replays += 1,
            Ok(None) => break Ok(replays),
            Err(why) => break Err(why),
        }
    };
    let estimated = estimate::record_missing(conn, seller).await.map(|run| {
        run.map_or_else(Vec::new, |run| {
            run.recorded.iter().map(|r| r.batch_number).collect()
        })
    });
    Cycle {
        synced,
        replays: replayed,
        estimated,
    }
}

/// When the next sync step is due, after a cycle's: in an hour once the scan is complete, in a
/// minute after a failure, and at the next cycle otherwise.
pub fn next_sync(cycle: &Cycle, now: Instant, due: Instant) -> Instant {
    match &cycle.synced {
        Some(Ok(coverage)) if coverage.status == "complete" => now + SYNC_EVERY,
        Some(Err(_)) => now + IDLE,
        _ => due,
    }
}

/// How long to wait before the next cycle: a moment while the scan or the queue is behind, at
/// most a minute, and no later than the next sync step.
pub fn pause(cycle: &Cycle, now: Instant, next_sync: Instant) -> Duration {
    let budget_reached = matches!(&cycle.synced, Some(Ok(c))
        if c.status == "incomplete"
            && c.error.as_deref().is_some_and(|e| e.starts_with("Sync request budget reached")));
    let mut delay = if budget_reached || matches!(cycle.replays, Ok(REPLAYS)) {
        BEHIND
    } else {
        IDLE
    };
    if next_sync > now {
        delay = delay.min((next_sync - now).max(BEHIND));
    }
    delay
}

fn report(cycle: &Cycle) {
    match &cycle.synced {
        Some(Ok(c)) => println!(
            "Seller order history worker {} offset={} total={}",
            c.status,
            c.next_offset,
            c.expected_total
                .map_or_else(|| "unknown".to_owned(), |t| t.to_string()),
        ),
        Some(Err(why)) => eprintln!("Seller order history worker history cycle failed: {why}"),
        None => {}
    }
    match &cycle.replays {
        Ok(0) => {}
        Ok(replays) => println!("Seller order history worker fifo replays={replays}"),
        Err(why) => eprintln!("Seller order history worker FIFO cycle failed: {why}"),
    }
    match &cycle.estimated {
        Ok(batches) if batches.is_empty() => {}
        Ok(batches) => println!(
            "Seller order history worker estimated purchase costs batches={}",
            batches
                .iter()
                .map(i32::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
        Err(why) => {
            eprintln!("Seller order history worker estimated purchase cost cycle failed: {why}")
        }
    }
}

/// The app's task: a cycle at once, then each after its pause, until shutdown.
pub async fn run(db: Database, signal: Signal) {
    println!("Seller order history worker started");
    let tcg = TcgPlayer::new(db.clone());
    let orders = OrderManagement(&tcg);
    let mut due = Instant::now();
    loop {
        if signal.is_aborted() {
            return;
        }
        let seller = match shipping_configuration::default_seller_key(&db).await {
            Ok(seller) => seller.trim().to_owned(),
            Err(why) => {
                eprintln!("Seller order history worker seller configuration failed: {why}");
                String::new()
            }
        };
        let now = Instant::now();
        let delay = if seller.is_empty() {
            IDLE
        } else {
            // Each write is a transaction, so a cycle dropped at shutdown leaves none half done; a
            // sync run it held is resumed by the next claim once its two-minute lease expires.
            let stepped = tokio::select! {
                biased;
                _ = signal.aborted() => return,
                stepped = step(&db, &orders, &seller, now >= due) => stepped,
            };
            match stepped {
                Ok(cycle) => {
                    report(&cycle);
                    due = next_sync(&cycle, Instant::now(), due);
                    pause(&cycle, Instant::now(), due)
                }
                Err(why) => {
                    eprintln!("Seller order history worker cycle failed: {why}");
                    IDLE
                }
            }
        };
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = sleep(delay) => {}
        }
    }
}

async fn step(
    db: &Database,
    orders: &impl Orders,
    seller: &str,
    sync_due: bool,
) -> Result<Cycle, String> {
    let mut conn = db.0.acquire().await.map_err(|e| e.to_string())?;
    let claim: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(cycle(&mut conn, orders, seller, sync_due, &claim, &iso_now).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::seller_order_history::fixtures::RecordedOrders;

    fn synced(status: &str, error: Option<&str>) -> Option<Result<Coverage, String>> {
        Some(Ok(Coverage {
            status: status.into(),
            orders_observed: 0,
            details_recorded: 0,
            next_offset: 0,
            expected_total: None,
            gaps: Vec::new(),
            error: error.map(str::to_owned),
        }))
    }

    fn did(synced: Option<Result<Coverage, String>>, replays: usize) -> Cycle {
        Cycle {
            synced,
            replays: Ok(replays),
            estimated: Ok(Vec::new()),
        }
    }

    #[test]
    fn a_complete_scan_waits_an_hour_and_one_behind_goes_on() {
        let now = Instant::now();
        let complete = did(synced("complete", None), 0);
        assert_eq!(next_sync(&complete, now, now), now + SYNC_EVERY);
        assert_eq!(pause(&complete, now, now + SYNC_EVERY), IDLE);

        let budgeted = did(
            synced(
                "incomplete",
                Some("Sync request budget reached; resume from the saved offset."),
            ),
            0,
        );
        assert_eq!(next_sync(&budgeted, now, now), now);
        assert_eq!(pause(&budgeted, now, now), BEHIND);

        let missing = did(
            synced(
                "incomplete",
                Some(
                    "All search pages were read, but one or more order details are still missing.",
                ),
            ),
            0,
        );
        assert_eq!(pause(&missing, now, now), IDLE);

        let failed = did(Some(Err("down".into())), 0);
        assert_eq!(next_sync(&failed, now, now), now + IDLE);
    }

    #[test]
    fn a_full_replay_or_a_sync_coming_due_shortens_the_pause() {
        let now = Instant::now();
        assert_eq!(pause(&did(None, REPLAYS), now, now + SYNC_EVERY), BEHIND);
        assert_eq!(pause(&did(None, 3), now, now + SYNC_EVERY), IDLE);
        assert_eq!(
            pause(&did(None, 0), now, now + Duration::from_secs(10)),
            Duration::from_secs(10)
        );
        assert_eq!(
            pause(&did(None, 0), now, now + Duration::from_millis(500)),
            BEHIND
        );
    }

    /// Two cycles for seller `fixture-seller` over the recorded orders, in a transaction on the dev
    /// database that is rolled back: the first records the orders but one, whose detail fails, and
    /// replays the SKUs they queued (held: the seller has no opening balance); the second reads the
    /// missing detail, completes the scan and replays its SKUs, which leaves every one held.
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn a_cycle_syncs_replays_and_estimates() {
        use sqlx::Connection;
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let orders = RecordedOrders::new();
        let now = || "2026-10-30T12:00:00.000Z".to_owned();
        let first = cycle(
            &mut tx,
            &orders,
            "fixture-seller",
            true,
            "00000000-0000-4000-8000-000000000001",
            &now,
        )
        .await;
        let second = cycle(
            &mut tx,
            &orders,
            "fixture-seller",
            true,
            "00000000-0000-4000-8000-000000000002",
            &now,
        )
        .await;
        let queued: Vec<(String, Option<String>, i64)> = sqlx::query_as(
            "SELECT status,hold_reason,count(*) FROM inventory_fifo_replay_queue
             WHERE seller_key='fixture-seller' GROUP BY 1,2 ORDER BY 1,2",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        println!("{queued:?}");
        let held: i64 = queued
            .iter()
            .filter(|(_, reason, _)| reason.as_deref() == Some("missing_applied_opening_balance"))
            .map(|(_, _, n)| n)
            .sum();
        tx.rollback().await.unwrap();
        println!("{first:?}\n{second:?}");
        let first_sync = first.synced.unwrap().unwrap();
        assert_eq!(first_sync.status, "incomplete");
        assert_eq!(first_sync.gaps.len(), 1);
        assert!(
            first.replays.as_ref().is_ok_and(|n| *n > 0),
            "the first cycle replays what it queued"
        );
        assert!(first.estimated.is_ok());
        assert_eq!(second.synced.unwrap().unwrap().status, "complete");
        assert!(
            second.replays.as_ref().is_ok_and(|n| *n > 0),
            "the second replays the order it read late"
        );
        // The six orders of the search page hold 21 SKUs; the worker asks about no order first.
        assert_eq!(queued.len(), 1, "every queued SKU is held");
        assert_eq!(held, 21);
    }
}
