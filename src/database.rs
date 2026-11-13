//! The Postgres database. Its schema is `db/migrations`, applied by this server as it starts when
//! `MIGRATE_ON_START` is set (`crate::migrations`), or by `npm run db:migrate`.
use std::time::Duration;

use sqlx::{PgPool, postgres::PgPoolOptions};

/// How long a query waits for a connection before it fails: well inside a page's 30 s deadline, so
/// a database that is down is a page that says so, not one that waits out the deadline.
const CONNECTION_WAIT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Database(pub PgPool);

impl Database {
    /// A pool that connects on first use, so the app starts while the database is still coming up
    /// and says so through its readiness check.
    pub fn connect_lazy(url: &str) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(20)
            .acquire_timeout(CONNECTION_WAIT)
            .idle_timeout(Duration::from_secs(30))
            .connect_lazy(url)
            .expect("DATABASE_URL is a Postgres URL");
        Database(pool)
    }

    /// Whether a query gets an answer: what `/health/ready` reports. Corten answers
    /// `unavailable` when this has not finished in 800 ms (`App::ready_within`), so it needs no
    /// timeout of its own.
    pub async fn reachable(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.0).await.is_ok()
    }
}
