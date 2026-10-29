//! The Postgres database the Node app owns. Its migrations (`db/migrations`, applied by
//! `npm run db:migrate`) stay the schema's one source until the workers move here too.
use sqlx::{PgPool, postgres::PgPoolOptions};

#[derive(Clone)]
pub struct Database(pub PgPool);

impl Database {
    /// A pool that connects on first use, so the app starts while the database is still coming up
    /// and says so through its readiness check.
    pub fn connect_lazy(url: &str) -> Self {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_lazy(url)
            .expect("DATABASE_URL is a Postgres URL");
        Database(pool)
    }

    /// Whether a query gets an answer: what `/health/ready` reports.
    pub async fn reachable(&self) -> bool {
        sqlx::query("SELECT 1").execute(&self.0).await.is_ok()
    }
}
