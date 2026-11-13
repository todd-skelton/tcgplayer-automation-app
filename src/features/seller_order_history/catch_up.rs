//! Moving the seller's order history scan on when asked, these orders first (`/api/seller-order-history`'s
//! `catch_up`): one step of the sync within the default budget, sharing the run's claim with the
//! workers.
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

/// A catch-up asked for `named` (else the default shipping seller),
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
    use super::*;

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
}
