//! Work that must not run twice at once, whichever tab, computer or app instance asks: buying
//! postage, which is paid for, and marking orders shipped, which messages buyers. Each holds a
//! Postgres advisory lock in a transaction of its own, so every process on the database sees it,
//! and the lock goes with the transaction when the work ends, however it ends.
use sqlx::{Postgres, Transaction};

use crate::database::Database;

/// One kind of work, named for its lock.
pub struct OneAtATime(&'static str);

/// The work running, until it is dropped.
pub struct Running {
    _locked: Transaction<'static, Postgres>,
}

impl OneAtATime {
    pub const fn new(name: &'static str) -> Self {
        OneAtATime(name)
    }

    /// The work, or none while it is already running anywhere.
    pub async fn start(&self, db: &Database) -> sqlx::Result<Option<Running>> {
        let mut tx = db.0.begin().await?;
        let taken: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtext($1))")
            .bind(self.0)
            .fetch_one(&mut *tx)
            .await?;
        Ok(taken.then_some(Running { _locked: tx }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "takes an advisory lock on the dev database"]
    async fn work_runs_once_at_a_time() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let work = OneAtATime::new("shipping export one at a time test");
        let first = work.start(&db).await.unwrap().expect("nothing is running");
        assert!(
            work.start(&db).await.unwrap().is_none(),
            "a second waits for the first"
        );
        drop(first);
        // The rollback that frees the lock runs as the connection goes back to the pool.
        let mut again = None;
        for _ in 0..50 {
            again = work.start(&db).await.unwrap();
            if again.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(again.is_some(), "the first is over");
    }
}
