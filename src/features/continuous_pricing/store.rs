//! What the screen reads and the writes simple enough to make here: the schedule settings (in the
//! publication settings document, under `continuousPricing`), the seller's tracked inventory, its
//! status, the recent automatic runs, and pausing or enabling a SKU. The same queries as the Node
//! app's `continuousPricingRepository`, which the scheduler and the pricing worker share.
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::database::Database;

/// The publication settings row, whose document holds the schedule.
const CONFIG_KEY: &str = "default";

/// The schedule, as `normalizeContinuousPricingSettings` reads it: a value missing or out of its
/// range is its default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub seller_key: String,
    pub minimum_interval_minutes: i64,
    pub inventory_refresh_minutes: i64,
    pub scheduler_poll_seconds: i64,
    pub batch_size: i64,
}

/// Each number's range, as the Node app clamps it.
pub mod range {
    use std::ops::RangeInclusive;
    pub const MINIMUM_INTERVAL: RangeInclusive<i64> = 15..=30 * 24 * 60;
    pub const INVENTORY_REFRESH: RangeInclusive<i64> = 5..=7 * 24 * 60;
    pub const SCHEDULER_POLL: RangeInclusive<i64> = 5..=60 * 60;
    pub const BATCH_SIZE: RangeInclusive<i64> = 1..=750;
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            enabled: false,
            seller_key: String::new(),
            minimum_interval_minutes: 24 * 60,
            inventory_refresh_minutes: 60,
            scheduler_poll_seconds: 30,
            batch_size: 100,
        }
    }
}

impl Settings {
    /// The schedule in a stored `continuousPricing` document.
    pub fn of(stored: &Value) -> Settings {
        let d = Settings::default();
        let whole = |key: &str, fallback: i64, range: std::ops::RangeInclusive<i64>| {
            stored
                .get(key)
                .and_then(Value::as_i64)
                .filter(|n| range.contains(n))
                .unwrap_or(fallback)
        };
        Settings {
            enabled: stored
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(d.enabled),
            seller_key: stored
                .get("sellerKey")
                .and_then(Value::as_str)
                .map_or(d.seller_key, |k| k.trim().chars().take(200).collect()),
            minimum_interval_minutes: whole(
                "minimumIntervalMinutes",
                d.minimum_interval_minutes,
                range::MINIMUM_INTERVAL,
            ),
            inventory_refresh_minutes: whole(
                "inventoryRefreshMinutes",
                d.inventory_refresh_minutes,
                range::INVENTORY_REFRESH,
            ),
            scheduler_poll_seconds: whole(
                "schedulerPollSeconds",
                d.scheduler_poll_seconds,
                range::SCHEDULER_POLL,
            ),
            batch_size: whole("batchSize", d.batch_size, range::BATCH_SIZE),
        }
    }
}

pub async fn settings(db: &Database) -> sqlx::Result<Settings> {
    let stored: Option<Value> = sqlx::query_scalar(
        "SELECT settings_json -> 'continuousPricing' FROM inventory_publication_settings
        WHERE config_key = $1",
    )
    .bind(CONFIG_KEY)
    .fetch_optional(&db.0)
    .await?
    .flatten();
    Ok(Settings::of(&stored.unwrap_or(Value::Null)))
}

/// Saves the schedule, leaving the rest of the publication settings as they are.
pub async fn save(db: &Database, settings: &Settings) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO inventory_publication_settings (config_key, settings_json, updated_at)
        VALUES ($1, jsonb_build_object('continuousPricing', $2::jsonb), NOW())
        ON CONFLICT (config_key) DO UPDATE SET
            settings_json = inventory_publication_settings.settings_json
                || jsonb_build_object('continuousPricing', $2::jsonb),
            updated_at = NOW()",
    )
    .bind(CONFIG_KEY)
    .bind(serde_json::to_value(settings).expect("settings are JSON"))
    .execute(&db.0)
    .await?;
    Ok(())
}

/// The seller's tracked inventory at a glance.
#[derive(Clone, Debug, Default, sqlx::FromRow)]
pub struct Status {
    pub inventory_count: i32,
    pub in_stock_sku_count: i32,
    pub available_unit_count: i32,
    pub current_inventory_value: f64,
    pub current_market_value: f64,
    pub market_comparable_market_value: f64,
    pub market_comparable_listed_value: f64,
    pub market_value_sku_count: i32,
    pub priced_in_stock_sku_count: i32,
    pub needs_review_count: i32,
    pub enabled_in_stock_count: i32,
    pub due_count: i32,
    #[sqlx(skip)]
    pub awaiting_publication: (i32, i32),
    #[sqlx(skip)]
    pub last_refresh: Option<Refresh>,
}

/// The seller's latest inventory refresh.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Refresh {
    pub status: String,
    pub error_message: Option<String>,
    pub completed_at: Option<DateTime<Utc>>,
    pub started_at: DateTime<Utc>,
}

impl Refresh {
    pub fn at(&self) -> DateTime<Utc> {
        self.completed_at.unwrap_or(self.started_at)
    }
}

impl Status {
    /// How far the listed value sits from market, in percent, where both are known.
    pub fn market_difference(&self) -> Option<f64> {
        (self.market_comparable_market_value > 0.0).then(|| {
            (self.market_comparable_listed_value - self.market_comparable_market_value)
                / self.market_comparable_market_value
                * 100.0
        })
    }

    /// `80%` of in-stock SKUs priced.
    pub fn coverage(&self) -> String {
        if self.in_stock_sku_count == 0 {
            return "0%".into();
        }
        let share = f64::from(self.priced_in_stock_sku_count) / f64::from(self.in_stock_sku_count);
        format!("{}%", (share * 100.0).round())
    }
}

const DUE: &str = "enabled AND pricing_eligible AND in_stock AND quantity > 0
    AND pause_reason IS NULL AND next_price_at <= NOW()";

pub async fn status(db: &Database, seller: &str) -> sqlx::Result<Status> {
    let mut status: Status = sqlx::query_as(&format!(
        "SELECT
            COUNT(*)::INTEGER AS inventory_count,
            COUNT(*) FILTER (WHERE in_stock AND quantity > 0)::INTEGER AS in_stock_sku_count,
            COALESCE(SUM(quantity) FILTER (WHERE in_stock AND quantity > 0), 0)::INTEGER
                AS available_unit_count,
            COALESCE(SUM(quantity * current_price) FILTER (
                WHERE in_stock AND quantity > 0 AND current_price IS NOT NULL), 0)::FLOAT8
                AS current_inventory_value,
            COALESCE(SUM(quantity * market_price) FILTER (
                WHERE in_stock AND quantity > 0 AND market_price IS NOT NULL), 0)::FLOAT8
                AS current_market_value,
            COALESCE(SUM(quantity * market_price) FILTER (
                WHERE in_stock AND quantity > 0 AND market_price IS NOT NULL
                    AND current_price IS NOT NULL), 0)::FLOAT8 AS market_comparable_market_value,
            COALESCE(SUM(quantity * current_price) FILTER (
                WHERE in_stock AND quantity > 0 AND market_price IS NOT NULL
                    AND current_price IS NOT NULL), 0)::FLOAT8 AS market_comparable_listed_value,
            COUNT(*) FILTER (WHERE in_stock AND quantity > 0 AND market_price IS NOT NULL)::INTEGER
                AS market_value_sku_count,
            COUNT(*) FILTER (WHERE in_stock AND quantity > 0 AND last_priced_at IS NOT NULL)::INTEGER
                AS priced_in_stock_sku_count,
            COUNT(*) FILTER (WHERE pause_reason IS NOT NULL)::INTEGER AS needs_review_count,
            COUNT(*) FILTER (WHERE enabled AND pricing_eligible AND in_stock AND quantity > 0)::INTEGER
                AS enabled_in_stock_count,
            COUNT(*) FILTER (WHERE {DUE})::INTEGER AS due_count
        FROM continuous_pricing_inventory
        WHERE seller_key = $1"
    ))
    .bind(seller)
    .fetch_one(&db.0)
    .await?;
    status.awaiting_publication = sqlx::query_as(
        "SELECT COUNT(*)::INTEGER, COALESCE(SUM(item.add_to_quantity), 0)::INTEGER
        FROM inventory_batch_items item
        JOIN inventory_batches batch ON batch.batch_number = item.batch_number
        JOIN inventory_batch_results result
            ON result.batch_number = item.batch_number AND result.sku = item.sku
        WHERE batch.source_type = 'pending_inventory'
            AND item.add_to_quantity > 0
            AND result.result_status = 'successful'
            AND NOT EXISTS (
                SELECT 1 FROM inventory_publication_items publication_item
                WHERE publication_item.inventory_delta_key =
                        'inventory-batch-item:' || item.batch_number || ':' || item.sku
                    AND publication_item.status = 'published')",
    )
    .fetch_one(&db.0)
    .await?;
    status.last_refresh = sqlx::query_as(
        "SELECT status, error_message, completed_at, started_at
        FROM continuous_pricing_refreshes
        WHERE seller_key = $1
        ORDER BY started_at DESC, id DESC
        LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&db.0)
    .await?;
    Ok(status)
}

/// Which of the tracked inventory a page lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, corten::UrlValue, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Shown {
    #[default]
    All,
    Enabled,
    Paused,
    NeedsReview,
    InStock,
    OutOfStock,
    Due,
}

impl Shown {
    pub const ALL: [Shown; 7] = [
        Shown::All,
        Shown::Enabled,
        Shown::Paused,
        Shown::NeedsReview,
        Shown::InStock,
        Shown::OutOfStock,
        Shown::Due,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Shown::All => "All inventory",
            Shown::Enabled => "Enabled",
            Shown::Paused => "Paused",
            Shown::NeedsReview => "Needs review",
            Shown::InStock => "In stock",
            Shown::OutOfStock => "Out of stock",
            Shown::Due => "Due now",
        }
    }

    fn condition(self) -> &'static str {
        match self {
            Shown::All => "TRUE",
            Shown::Enabled => "enabled AND pricing_eligible AND pause_reason IS NULL",
            Shown::Paused => "NOT enabled",
            Shown::NeedsReview => "pause_reason IS NOT NULL",
            Shown::InStock => "in_stock AND quantity > 0",
            Shown::OutOfStock => "NOT in_stock OR quantity <= 0",
            Shown::Due => DUE,
        }
    }
}

/// A SKU the scheduler tracks.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Item {
    pub sku: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub quantity: i32,
    pub current_price: Option<f64>,
    pub pricing_eligible: bool,
    pub enabled: bool,
    pub pause_reason: Option<String>,
    pub last_priced_at: Option<DateTime<Utc>>,
    pub last_published_at: Option<DateTime<Utc>>,
    pub next_price_at: DateTime<Utc>,
}

impl Item {
    /// Its switch is on: enabled and not waiting on a review.
    pub fn on(&self) -> bool {
        self.enabled && self.pause_reason.is_none()
    }

    pub fn state(&self) -> &'static str {
        if !self.pricing_eligible {
            "Excluded by product-line config"
        } else if self.pause_reason.is_some() {
            "Needs review"
        } else if self.enabled {
            "Enabled"
        } else {
            "Paused"
        }
    }
}

/// One page of the tracked inventory and where it sits in the whole.
#[derive(Clone, Debug, Default)]
pub struct Page {
    pub items: Vec<Item>,
    pub total: i64,
    pub page: i64,
}

pub const PAGE_SIZE: i64 = 50;

impl Page {
    pub fn pages(&self) -> i64 {
        ((self.total + PAGE_SIZE - 1) / PAGE_SIZE).max(1)
    }

    /// `51-100 of 120`.
    pub fn range(&self) -> String {
        let first = if self.total == 0 {
            0
        } else {
            (self.page - 1) * PAGE_SIZE + 1
        };
        let last = self.total.min(self.page * PAGE_SIZE);
        format!("{first}-{last} of {}", self.total)
    }
}

/// The page of the seller's inventory matching `search` (a SKU, or part of a product, set,
/// condition or product line), a page past the last being the last.
pub async fn page(
    db: &Database,
    seller: &str,
    search: &str,
    shown: Shown,
    page: i64,
) -> sqlx::Result<Page> {
    let filter = format!(
        "seller_key = $1
        AND ($2 = '' OR sku::text = $2 OR product_name ILIKE '%' || $2 || '%'
            OR set_name ILIKE '%' || $2 || '%' OR condition ILIKE '%' || $2 || '%'
            OR product_line ILIKE '%' || $2 || '%')
        AND ({})",
        shown.condition()
    );
    let search = search.trim();
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM continuous_pricing_inventory WHERE {filter}"
    ))
    .bind(seller)
    .bind(search)
    .fetch_one(&db.0)
    .await?;
    let last = ((total + PAGE_SIZE - 1) / PAGE_SIZE).max(1);
    let page = page.clamp(1, last);
    let items = sqlx::query_as(&format!(
        "SELECT sku, product_line, set_name, product_name, condition, quantity,
            current_price::FLOAT8 AS current_price, pricing_eligible, enabled, pause_reason,
            last_priced_at, last_published_at, next_price_at
        FROM continuous_pricing_inventory
        WHERE {filter}
        ORDER BY enabled DESC, in_stock DESC, next_price_at, sku
        LIMIT $3 OFFSET $4"
    ))
    .bind(seller)
    .bind(search)
    .bind(PAGE_SIZE)
    .bind((page - 1) * PAGE_SIZE)
    .fetch_all(&db.0)
    .await?;
    Ok(Page { items, total, page })
}

/// An automatic pricing run: a continuous batch and the priority of its latest pricing job.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Run {
    pub batch_number: i32,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub item_count: i32,
    pub priority: Option<i32>,
}

/// The newest automatic runs shown.
pub const RECENT_RUNS: i64 = 25;

pub async fn recent_runs(db: &Database) -> sqlx::Result<Vec<Run>> {
    sqlx::query_as(
        "SELECT b.batch_number, b.status, b.created_at,
            (SELECT COUNT(*)::INTEGER FROM inventory_batch_items i
                WHERE i.batch_number = b.batch_number) AS item_count,
            (SELECT j.priority FROM inventory_batch_pricing_jobs j
                WHERE j.batch_number = b.batch_number
                ORDER BY j.created_at DESC, j.id DESC LIMIT 1) AS priority
        FROM inventory_batches b
        WHERE b.source_type = 'continuous'
        ORDER BY b.batch_number DESC
        LIMIT $1",
    )
    .bind(RECENT_RUNS)
    .fetch_all(&db.0)
    .await
}

/// Enables a SKU (clearing its review and failures, and making it due now) or pauses it. Whether
/// the seller tracks it.
pub async fn set_enabled(
    db: &Database,
    seller: &str,
    sku: i32,
    enabled: bool,
) -> sqlx::Result<bool> {
    let changed = sqlx::query(
        "UPDATE continuous_pricing_inventory
        SET enabled = $3,
            pause_reason = CASE WHEN $3 THEN NULL ELSE pause_reason END,
            consecutive_pricing_failures = CASE WHEN $3 THEN 0 ELSE consecutive_pricing_failures END,
            next_price_at = CASE WHEN $3 THEN LEAST(next_price_at, NOW()) ELSE next_price_at END,
            updated_at = NOW()
        WHERE seller_key = $1 AND sku = $2",
    )
    .bind(seller)
    .bind(sku)
    .bind(enabled)
    .execute(&db.0)
    .await?;
    Ok(changed.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_stored_schedule_reads_as_the_node_app_normalizes_it() {
        let read = Settings::of(&json!({
            "enabled": true, "sellerKey": "  abc  ", "minimumIntervalMinutes": 10,
            "inventoryRefreshMinutes": 30, "batchSize": 751, "schedulerPollSeconds": 1.5
        }));
        assert_eq!(
            read,
            Settings {
                enabled: true,
                seller_key: "abc".into(),
                minimum_interval_minutes: 1440,
                inventory_refresh_minutes: 30,
                scheduler_poll_seconds: 30,
                batch_size: 100,
            }
        );
        assert_eq!(Settings::of(&Value::Null), Settings::default());
    }

    #[test]
    fn coverage_and_market_difference_read_as_the_react_screen_wrote_them() {
        let status = Status {
            in_stock_sku_count: 3,
            priced_in_stock_sku_count: 2,
            market_comparable_market_value: 200.0,
            market_comparable_listed_value: 190.0,
            ..Status::default()
        };
        assert_eq!(status.coverage(), "67%");
        assert_eq!(status.market_difference(), Some(-5.0));
        assert_eq!(Status::default().coverage(), "0%");
        assert_eq!(Status::default().market_difference(), None);
    }

    #[test]
    fn a_page_says_which_rows_it_shows() {
        let page = Page {
            items: Vec::new(),
            total: 120,
            page: 3,
        };
        assert_eq!(page.range(), "101-120 of 120");
        assert_eq!(page.pages(), 3);
        assert_eq!(Page::default().range(), "0-0 of 0");
    }
}
