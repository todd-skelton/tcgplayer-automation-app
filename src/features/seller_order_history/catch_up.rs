//! Moving the seller's order history scan on when asked, these orders first (`/api/seller-order-history`'s
//! `catch_up`): one step of the sync within the default budget, sharing the run's claim with the
//! workers, as the Node route takes it.
use sqlx::PgConnection;

use super::sync::{self, Budget, Orders, Synced};
use crate::{database::Database, features::shipping_configuration, tcgplayer::TcgPlayer};

/// The orders a catch-up reads first, at most.
pub const PRIORITY: usize = 25;

/// The seller a catch-up is for and the orders it reads first: the seller named, else the
/// configured one, and the first [`PRIORITY`] orders asked about.
pub fn asked(
    named: &str,
    configured: &str,
    orders: &[String],
) -> Result<(String, Vec<String>), String> {
    let seller = match named.trim() {
        "" => configured.trim(),
        named => named,
    };
    if seller.is_empty() {
        return Err("Error: A seller key is required.".to_owned());
    }
    Ok((
        seller.to_owned(),
        orders.iter().take(PRIORITY).cloned().collect(),
    ))
}

/// A catch-up asked for `named` (else the default shipping seller, as the Node route resolves it),
/// `orders` read from TCGplayer first: the seller it was for and what it did.
pub async fn requested(
    db: &Database,
    named: &str,
    orders: &[String],
) -> Result<(String, Synced), String> {
    let failed = |e: sqlx::Error| format!("Error: {e}");
    let configured = match named.trim() {
        "" => shipping_configuration::default_seller_key(db)
            .await
            .map_err(failed)?,
        _ => String::new(),
    };
    let (seller, priority) = asked(named, &configured, orders)?;
    let tcgplayer = TcgPlayer::new(db.clone());
    let mut conn = db.0.acquire().await.map_err(failed)?;
    let api = super::api::OrderManagement(&tcgplayer);
    let now = super::worker::iso_now;
    let synced = catch_up(&mut conn, &api, &seller, &priority, &now).await?;
    Ok((seller, synced))
}

/// One step of the seller's scan on `conn`, `priority`'s orders read first, observed `now`.
pub async fn catch_up(
    conn: &mut PgConnection,
    orders: &impl Orders,
    seller: &str,
    priority: &[String],
    now: &(dyn Fn() -> String + Sync),
) -> Result<Synced, String> {
    let failed = |e: sqlx::Error| format!("Error: {e}");
    let claim: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *conn)
        .await
        .map_err(failed)?;
    let store = super::store::Postgres::new(conn);
    sync::synchronize(
        orders,
        &store,
        seller,
        Budget::default(),
        priority,
        &claim,
        now,
    )
    .await
    .map_err(|e| format!("Error: {e}"))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::{Value, json};

    use super::*;
    use crate::{
        database::Database,
        features::seller_order_history::{
            api::SearchPage, fixtures::RecordedOrders, observation::Fields,
        },
        tcgplayer::Failure,
    };

    /// The recorded answers, noting each request as `catchup-node.ts` notes Node's.
    struct Noted {
        orders: RecordedOrders,
        asked: Mutex<Vec<String>>,
    }

    impl Noted {
        fn note(&self, request: String) {
            self.asked.lock().unwrap().push(request);
        }
    }

    impl Orders for Noted {
        async fn search(&self, seller: &str, from: u32, size: u32) -> Result<SearchPage, Failure> {
            self.note(format!("search {from} {size}"));
            self.orders.search(seller, from, size).await
        }
        async fn find(&self, seller: &str, number: &str) -> Result<Option<Fields>, Failure> {
            self.note(format!("find {number}"));
            self.orders.find(seller, number).await
        }
        async fn order(&self, number: &str) -> Result<Fields, Failure> {
            self.note(format!("order {number}"));
            self.orders.order(number).await
        }
    }

    #[test]
    fn the_seller_is_the_one_named_else_the_configured_one() {
        let orders: Vec<String> = (0..30).map(|n| n.to_string()).collect();
        let (seller, priority) = asked(" named ", "configured", &orders).unwrap();
        assert_eq!(seller, "named");
        assert_eq!(priority, orders[..PRIORITY]);
        assert_eq!(asked("  ", " configured ", &[]).unwrap().0, "configured");
        assert_eq!(
            asked("", " ", &[]).unwrap_err(),
            "Error: A seller key is required."
        );
    }

    /// Two catch-ups for ` fixture-seller ` over the recorded orders, asked about the orders in
    /// `.port-logs/catchup-cases.json`, in a transaction on the dev database that is rolled back,
    /// compared with what Node's route answered, asked and wrote (`catchup-node.ts`, captured by
    /// `order-sync-capture.sql`).
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn catches_up_as_node_does() {
        use sqlx::Connection;
        crate::config::load_env();
        let read_log = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let node: Value = serde_json::from_str(&read_log("catchup.node.json")).unwrap();
        let cases: Value = serde_json::from_str(&read_log("catchup-cases.json")).unwrap();
        let numbers: Vec<String> = serde_json::from_value(cases["orderNumbers"].clone()).unwrap();
        let (seller, priority) = asked(" fixture-seller ", "", &numbers).unwrap();
        let api = Noted {
            orders: RecordedOrders::new(),
            asked: Mutex::new(Vec::new()),
        };
        let now = || "2026-10-30T12:00:00.000Z".to_owned();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut conn = db.0.acquire().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let mut steps = Vec::new();
        for _ in 0..2 {
            let synced = catch_up(&mut tx, &api, &seller, &priority, &now)
                .await
                .unwrap();
            let c = synced.coverage;
            let mut changed = synced.changed;
            changed.sort();
            steps.push(json!({
                "status": c.status,
                "nextOffset": c.next_offset,
                "expectedTotal": c.expected_total,
                "ordersObserved": c.orders_observed,
                "detailsRecorded": c.details_recorded,
                "gaps": c.gaps.iter().map(|g| g.order_number.clone()).collect::<Vec<_>>(),
                "error": c.error,
                "changed": changed,
            }));
        }
        let capture = read_log("order-sync-capture.sql");
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(Value::Array(steps), node["steps"]);
        let mut asked = api.asked.into_inner().unwrap();
        asked.sort();
        assert_eq!(json!(asked), node["asked"]);
        let captured: Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(captured, node["captured"]);
    }
}
