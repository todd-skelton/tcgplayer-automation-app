//! The schema's migrations (`db/migrations`), applied as `npm run db:migrate`
//! applies them: in file-name order, each not yet named in `schema_migrations` run in a transaction of
//! its own with its name recorded, the first to fail stopping the rest. The files are built into the
//! server (`build.rs`).
//!
//! The server applies them before it serves when `MIGRATE_ON_START` is set, as production does. Both
//! runners hold the same advisory lock, so no two apply a migration at once.
use sqlx::{Connection, PgConnection};

/// Every migration, by file name, in the order applied.
pub const MIGRATIONS: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Whether `MIGRATE_ON_START` asks the server to apply them as it starts.
pub fn on() -> bool {
    crate::config::is_set("MIGRATE_ON_START")
}

/// Applies the migrations not yet applied to the database at `url`, holding a lock on it meanwhile.
pub async fn migrate(url: &str) -> Result<Vec<&'static str>, String> {
    let mut conn = PgConnection::connect(url)
        .await
        .map_err(|e| format!("Database migration failed: {e}"))?;
    sqlx::query("SELECT pg_advisory_lock(hashtext('schema_migrations'))")
        .execute(&mut conn)
        .await
        .map_err(|e| format!("Database migration failed: {e}"))?;
    let applied = apply(&mut conn, MIGRATIONS).await;
    // Closing the connection releases the lock, whatever happened.
    let _ = conn.close().await;
    applied
}

/// `run` in `db-migrate.mjs`: each of `migrations` not named in `schema_migrations` applied in a transaction
/// (a savepoint inside one already open) with its name; the names applied, or why one failed.
pub async fn apply(
    conn: &mut PgConnection,
    migrations: &[(&'static str, &str)],
) -> Result<Vec<&'static str>, String> {
    let failed = |name: &str, e: sqlx::Error| format!("Database migration {name} failed: {e}");
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           name TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|e| failed("schema_migrations", e))?;
    let mut done = Vec::new();
    for &(name, sql) in migrations {
        let applied: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)")
                .bind(name)
                .fetch_one(&mut *conn)
                .await
                .map_err(|e| failed(name, e))?;
        if applied {
            continue;
        }
        let mut tx = conn.begin().await.map_err(|e| failed(name, e))?;
        sqlx::raw_sql(sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| failed(name, e))?;
        sqlx::query("INSERT INTO schema_migrations (name) VALUES ($1)")
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(|e| failed(name, e))?;
        tx.commit().await.map_err(|e| failed(name, e))?;
        println!("Applied migration {name}");
        done.push(name);
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every file in `db/migrations` is built in, in the order the Node runner sorts them.
    #[test]
    fn every_migration_is_built_in_in_order() {
        let mut files: Vec<String> = std::fs::read_dir("db/migrations")
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".sql"))
            .collect();
        files.sort();
        let built: Vec<&str> = MIGRATIONS.iter().map(|(name, _)| *name).collect();
        assert_eq!(built, files);
        for (name, sql) in MIGRATIONS {
            let file = std::fs::read_to_string(format!("db/migrations/{name}")).unwrap();
            assert_eq!(*sql, file, "{name}");
        }
    }

    /// Every migration applied, as the Node runner applied them to the dev database, to an empty
    /// schema first on the search path, in a transaction rolled back: the schema it builds is the
    /// dev database's (`public`), table by table, column by column, index by index, constraint by
    /// constraint and function by function, and a second run applies nothing.
    #[tokio::test]
    #[ignore = "builds the schema in a scratch schema on the dev database, in a transaction rolled back"]
    async fn migrations_build_the_schema_node_built() {
        crate::config::load_env();
        let mut conn = PgConnection::connect(&crate::config::database_url())
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::raw_sql(
            "CREATE SCHEMA port_migrations; SET LOCAL search_path = port_migrations, public",
        )
        .execute(&mut *tx)
        .await
        .unwrap();
        let applied = apply(&mut tx, MIGRATIONS).await.unwrap();
        assert_eq!(applied.len(), MIGRATIONS.len());
        assert!(apply(&mut tx, MIGRATIONS).await.unwrap().is_empty());
        let shape = |schema: &str| {
            format!(
                "SELECT jsonb_build_object(
                  'columns', (SELECT jsonb_agg(concat_ws(' ', table_name, column_name, data_type, is_nullable, column_default)
                      ORDER BY table_name, column_name) FROM information_schema.columns WHERE table_schema = '{schema}'),
                  'indexes', (SELECT jsonb_agg(replace(indexdef, '{schema}.', '') ORDER BY indexname)
                      FROM pg_indexes WHERE schemaname = '{schema}'),
                  'constraints', (SELECT jsonb_agg(concat_ws(' ', c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
                      ORDER BY c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
                    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = '{schema}'),
                  'functions', (SELECT jsonb_agg(concat_ws(' ', p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc))
                      ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '{schema}'),
                  'migrations', (SELECT jsonb_agg(name ORDER BY name) FROM {schema}.schema_migrations)
                )::text"
            )
        };
        // Every name written in full, then each schema's own taken off, so both read alike.
        sqlx::query("SET LOCAL search_path = pg_catalog")
            .execute(&mut *tx)
            .await
            .unwrap();
        let read = |text: String, schema: &str| {
            serde_json::from_str::<serde_json::Value>(&text.replace(&format!("{schema}."), ""))
                .unwrap()
        };
        let ours: String = sqlx::query_scalar(&shape("port_migrations"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let node: String = sqlx::query_scalar(&shape("public"))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        tx.rollback().await.unwrap();
        let (ours, node) = (read(ours, "port_migrations"), read(node, "public"));
        for part in [
            "columns",
            "indexes",
            "constraints",
            "functions",
            "migrations",
        ] {
            assert!(
                ours[part].as_array().is_some_and(|a| !a.is_empty()),
                "{part}"
            );
            assert_eq!(ours[part], node[part], "{part}");
        }
    }
}
