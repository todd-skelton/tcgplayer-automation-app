//! Evidence maintenance for a seller: refreshing confirmed inventory in small groups and
//! updating recommendations from fresh saved evidence. It never publishes prices. The settings
//! and recent listing checks are read and saved here (`slabMaintenanceStore.server.ts`); the
//! cycles are run by a slab evidence worker when it has nothing to refresh: Node's until
//! cutover, or this app's (`maintenance_cycle`) when `SLAB_EVIDENCE_WORKER` is set. Node woke its
//! in-process worker when enabled settings were read or saved; a worker here finds due cycles on
//! its poll.
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::{FromRow, PgConnection};

use super::inventory::seller_account;
use crate::{
    database::Database,
    features::slab_connections::{self, Connection},
};

/// How often the status is read again while maintenance is enabled, as the React panel did.
pub const FOLLOWING: std::time::Duration = std::time::Duration::from_secs(5);

/// How many recent listing checks are shown.
const RECENT_CHECKS: i64 = 25;

/// What a seller's settings may be (`maintenanceSettings`).
const INTERVAL_MINUTES: std::ops::RangeInclusive<i64> = 15..=1440;
const BATCH_SIZE: std::ops::RangeInclusive<i64> = 1..=25;
const REFRESH_BUDGET: std::ops::RangeInclusive<i64> = 1..=50;

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub settings: Settings,
    pub items: Vec<Check>,
    pub providers: Vec<Connection>,
}

/// The seller's maintenance settings, with the last cycle's outcome; the defaults, never saved,
/// when the seller has none.
#[derive(Clone, Debug, PartialEq, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub seller: String,
    pub enabled: bool,
    pub include_supply: bool,
    pub interval_minutes: i32,
    pub batch_size: i32,
    pub refresh_budget: i32,
    pub revision: i32,
    pub next_cycle_at: Option<DateTime<Utc>>,
    pub last_cycle_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    #[sqlx(json(nullable))]
    pub last_summary: Option<Summary>,
}

impl Settings {
    /// `defaultMaintenanceSettings`.
    fn default_for(seller: String) -> Self {
        Settings {
            seller,
            enabled: false,
            include_supply: false,
            interval_minutes: 360,
            batch_size: 10,
            refresh_budget: 20,
            revision: 0,
            next_cycle_at: None,
            last_cycle_at: None,
            last_error: None,
            last_summary: None,
        }
    }
}

/// What the last cycle did.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Summary {
    #[serde(default)]
    pub checked: u32,
    #[serde(default)]
    pub queued: u32,
    #[serde(default)]
    pub recalculated: u32,
    #[serde(default)]
    pub held: u32,
}

/// One listing a cycle checked, and what it did.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, FromRow)]
pub struct Check {
    pub id: String,
    pub title: Option<String>,
    pub outcome: String,
    pub reason: String,
}

/// The settings as a person saves them, at the revision the form was drawn from.
#[derive(Debug)]
pub struct Saved<'a> {
    pub seller: &'a str,
    pub enabled: bool,
    pub include_supply: bool,
    pub interval_minutes: i64,
    pub batch_size: i64,
    pub refresh_budget: i64,
    pub revision: i64,
}

const FIELDS: &str =
    "seller, enabled, include_supply, interval_minutes, batch_size, refresh_budget, revision,
    next_cycle_at, last_cycle_at, last_error, last_summary";

/// The seller's maintenance as it stands (`maintenanceView`), or why the seller cannot have any.
pub async fn read(db: &Database, seller: &str) -> Result<View, String> {
    let mut conn = db.0.acquire().await.map_err(unavailable)?;
    load(&mut conn, seller).await
}

async fn load(conn: &mut PgConnection, seller: &str) -> Result<View, String> {
    let seller = seller_account(seller)?;
    let saved: Option<Settings> = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM slab_maintenance_settings WHERE seller = $1"
    ))
    .bind(&seller)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    let items: Vec<Check> = sqlx::query_as(
        "SELECT i.id::text AS id, i.snapshot->>'title' AS title, m.outcome, m.reason
         FROM slab_maintenance_items m JOIN slab_inventory i ON i.id = m.inventory_id
         WHERE i.seller = $1 ORDER BY m.checked_at DESC, i.id LIMIT $2",
    )
    .bind(&seller)
    .bind(RECENT_CHECKS)
    .fetch_all(&mut *conn)
    .await
    .map_err(unavailable)?;
    let providers = slab_connections::connections(&mut *conn)
        .await
        .map_err(unavailable)?;
    Ok(View {
        settings: saved.unwrap_or_else(|| Settings::default_for(seller)),
        items,
        providers,
    })
}

/// Saves the seller's settings (`saveMaintenanceSettings`): the first save only from revision 0,
/// a later one only from the revision saved, which it moves on, freeing any cycle's lease and
/// making a cycle due now. What the settings may be, and why a save is refused, are Node's.
pub async fn save(db: &Database, saved: &Saved<'_>) -> Result<Settings, String> {
    let mut conn = db.0.acquire().await.map_err(unavailable)?;
    record(&mut conn, saved).await
}

async fn record(conn: &mut PgConnection, saved: &Saved<'_>) -> Result<Settings, String> {
    if !INTERVAL_MINUTES.contains(&saved.interval_minutes)
        || !BATCH_SIZE.contains(&saved.batch_size)
        || !REFRESH_BUDGET.contains(&saved.refresh_budget)
        || saved.revision < 0
    {
        return Err(
            "Choose a 15–1,440 minute interval, 1–25 listings and 1–50 refresh jobs per cycle."
                .to_owned(),
        );
    }
    let seller = seller_account(saved.seller)?;
    let revision = i32::try_from(saved.revision).map_err(|_| CHANGED.to_owned())?;
    let values = (
        saved.enabled,
        saved.include_supply,
        saved.interval_minutes as i32,
        saved.batch_size as i32,
        saved.refresh_budget as i32,
    );
    let created: Option<Settings> = sqlx::query_as(&format!(
        "INSERT INTO slab_maintenance_settings (seller, enabled, include_supply, interval_minutes, batch_size, refresh_budget)
         SELECT $1, $2, $3, $4, $5, $6 WHERE $7 = 0 ON CONFLICT (seller) DO NOTHING RETURNING {FIELDS}"
    ))
    .bind(&seller)
    .bind(values.0)
    .bind(values.1)
    .bind(values.2)
    .bind(values.3)
    .bind(values.4)
    .bind(revision)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    if let Some(created) = created {
        return Ok(created);
    }
    let updated: Option<Settings> = sqlx::query_as(&format!(
        "UPDATE slab_maintenance_settings SET enabled = $2, include_supply = $3, interval_minutes = $4,
           batch_size = $5, refresh_budget = $6, revision = revision + 1, lease_id = NULL, lease_until = NULL,
           next_cycle_at = clock_timestamp(), last_error = NULL
         WHERE seller = $1 AND revision = $7 RETURNING {FIELDS}"
    ))
    .bind(&seller)
    .bind(values.0)
    .bind(values.1)
    .bind(values.2)
    .bind(values.3)
    .bind(values.4)
    .bind(revision)
    .fetch_optional(&mut *conn)
    .await
    .map_err(unavailable)?;
    updated.ok_or_else(|| CHANGED.to_owned())
}

const CHANGED: &str = "Maintenance settings changed. Reload before saving.";

/// Node hid what went wrong with the database behind this.
fn unavailable(error: sqlx::Error) -> String {
    eprintln!("slab maintenance: {error}");
    "Maintenance is unavailable.".to_owned()
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    /// Node's `/api/slab-maintenance` loader and action recorded over
    /// `.port-logs/slab-maintenance-cases.json` (`slab-maintenance-node.ts`) on the slabs and checks
    /// `slab-inventory-seed.sql` and `slab-maintenance-seed.sql` save: each read, then each save in
    /// order with every setting saved after it, inside a transaction rolled back. Node's refusals
    /// were 400s with its message, which is the message here.
    #[tokio::test]
    #[ignore = "reads the dev database and .port-logs; writes only in a transaction that is rolled back"]
    async fn reads_and_saves_as_node_does() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let read = |name: &str| std::fs::read_to_string(format!(".port-logs/{name}")).unwrap();
        let cases: Value = serde_json::from_str(&read("slab-maintenance-cases.json")).unwrap();
        let node: Value = serde_json::from_str(&read("slab-maintenance.node.json")).unwrap();
        let capture = read("slab-maintenance-capture.sql");
        let mut tx = db.0.begin().await.unwrap();
        sqlx::raw_sql(&read("slab-inventory-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::raw_sql(&read("slab-maintenance-seed.sql"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let reads = cases["reads"].as_array().unwrap();
        assert_eq!(reads.len(), node["reads"].as_array().unwrap().len());
        for (case, node) in reads.iter().zip(node["reads"].as_array().unwrap()) {
            let name = case["name"].as_str().unwrap();
            let got = load(&mut tx, case["seller"].as_str().unwrap()).await;
            match node["status"].as_u64() {
                Some(200) => {
                    let expected: View = serde_json::from_value(node["body"].clone()).unwrap();
                    assert_eq!(got.unwrap(), expected, "{name}");
                }
                _ => assert_eq!(got.unwrap_err(), node["body"]["error"], "{name}"),
            }
        }
        let saves = cases["saves"].as_array().unwrap();
        assert_eq!(saves.len(), node["saves"].as_array().unwrap().len());
        for (case, node) in saves.iter().zip(node["saves"].as_array().unwrap()) {
            let name = case["name"].as_str().unwrap();
            let s = &case["settings"];
            let number = |key: &str| s[key].as_i64().unwrap();
            let saved = Saved {
                seller: s["seller"].as_str().unwrap(),
                enabled: s["enabled"].as_bool().unwrap(),
                include_supply: s["includeSupply"].as_bool().unwrap(),
                interval_minutes: number("intervalMinutes"),
                batch_size: number("batchSize"),
                refresh_budget: number("refreshBudget"),
                revision: number("revision"),
            };
            let got = record(&mut tx, &saved).await;
            match node["error"].as_str() {
                None => {
                    let settings = got.unwrap_or_else(|why| panic!("{name}: {why}"));
                    assert_eq!(settings.seller, saved.seller.to_lowercase(), "{name}");
                }
                Some(error) => assert_eq!(got.unwrap_err(), error, "{name}"),
            }
            let after: Value = sqlx::query_scalar(&capture)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(after, node["saved"], "{name}: saved");
        }
        tx.rollback().await.unwrap();
    }
}
