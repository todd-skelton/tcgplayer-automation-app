//! The continuous pricing scheduler's queues (`continuousPricingRepository`): the SKUs due for
//! pricing as one batch, never more than one queued at a priority (`scheduleDueBatch`), and the
//! operator's repricing from saved curves (`scheduleCachedPolicyBatches`); and the scheduler's
//! cycle (`runContinuousPricingSchedulerCycle`), which refreshes the seller's inventory first when
//! it is stale.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{PgConnection, types::Json};

use crate::{
    database::Database,
    features::{
        batch_pricing::{job::MarketData, queue::priority, saved_curves::REUSABLE},
        configuration::config::{self as pricing_config},
        inventory_economics::ledger::fingerprint::js_float,
        pricing::policy::MODEL_VERSION,
    },
};

use super::{
    refresh::{self, SellerInventory},
    store::{self, Settings},
};

/// The seller's SKUs that may be priced now: enabled, eligible, in stock, not paused, due, and not
/// waiting in a continuous publication. `$1` is the seller.
const SCHEDULABLE: &str = "seller_key = $1
  AND enabled
  AND pricing_eligible
  AND in_stock
  AND quantity > 0
  AND pause_reason IS NULL
  AND next_price_at <= NOW()
  AND NOT EXISTS (
    SELECT 1
    FROM inventory_publication_items publication_item
    JOIN inventory_publications publication
      ON publication.id = publication_item.publication_id
    WHERE publication.source_type = 'continuous'
      AND publication.seller_key = continuous_pricing_inventory.seller_key
      AND publication.status IN ('planned', 'staging', 'staged', 'publishing', 'ambiguous')
      AND publication_item.sku = continuous_pricing_inventory.sku
      AND publication_item.status IN ('planned', 'ambiguous')
  )";

/// A SKU never priced, or whose last pricing failed, goes first.
const PRIORITY_DUE: &str = "(last_priced_at IS NULL OR consecutive_pricing_failures > 0)";

/// A tracked SKU as a batch takes it.
#[derive(Clone, Debug, PartialEq, sqlx::FromRow)]
pub struct Item {
    pub sku: i32,
    pub product_id: i32,
    pub product_line_id: i32,
    pub set_id: i32,
    pub product_line: String,
    pub set_name: String,
    pub product_name: String,
    pub condition: String,
    pub variant: String,
    pub quantity: i32,
    pub current_price: Option<f64>,
    pub market_price: Option<f64>,
}

const ITEM_COLUMNS: &str = "sku, product_id, product_line_id, set_id, product_line, set_name,
  product_name, condition, variant, quantity, current_price::float8 AS current_price,
  market_price::float8 AS market_price";

/// The SKU as a batch item's row (`toOriginalRow`).
fn original_row(item: &Item) -> Value {
    let price = |value: Option<f64>| value.map(js_float).unwrap_or_default();
    json!({
        "TCGplayer Id": item.sku.to_string(),
        "Product Line": item.product_line,
        "Set Name": item.set_name,
        "Product": item.product_name,
        "Sku Variant": item.variant,
        "Sku Condition": item.condition,
        "Sale Count": "",
        "Lowest Sale Price": "",
        "Highest Sale Price": "",
        "TCG Market Price": price(item.market_price),
        "Total Quantity": item.quantity.to_string(),
        "Add to Quantity": "0",
        "TCG Marketplace Price": price(item.current_price),
        "Previous Price": "",
        "Suggested Price": "",
        "Percentile Used": "",
        "Historical Sales Velocity (Days)": "",
        "Estimated Time to Sell (Days)": "",
        "Sales Count for Historical Calculation": "",
        "Listings Count for Estimated Calculation": "",
        "Warning": "",
        "Error": "",
    })
}

/// What a batch is queued with.
pub struct Queue<'a> {
    pub seller: &'a str,
    pub batch_size: i64,
    pub minimum_interval_minutes: i64,
    /// The pricing configuration as `normalizeServerPricingConfig` writes it.
    pub config: &'a Value,
}

impl<'a> Queue<'a> {
    pub fn of(settings: &'a Settings, config: &'a Value) -> Self {
        Queue {
            seller: &settings.seller_key,
            batch_size: settings.batch_size,
            minimum_interval_minutes: settings.minimum_interval_minutes,
            config,
        }
    }
}

/// Queues `items` as a continuous batch priced in `mode` (`createContinuousPricingBatch`), and
/// schedules each SKU's next pricing an interval after now, or in `cached` mode after its curve's
/// market reading.
async fn create_batch(
    conn: &mut PgConnection,
    items: &[Item],
    queue: &Queue<'_>,
    mode: &str,
    priority: i32,
    now: DateTime<Utc>,
) -> sqlx::Result<i32> {
    let batch_number: i32 = sqlx::query_scalar(
        "INSERT INTO inventory_batches (status, source_type, source_label)
         VALUES ('queued', 'continuous', $1) RETURNING batch_number",
    )
    .bind(queue.seller)
    .fetch_one(&mut *conn)
    .await?;
    let rows: Vec<Value> = items.iter().map(original_row).collect();
    let column = |f: fn(&Item) -> i32| items.iter().map(f).collect::<Vec<i32>>();
    sqlx::query(
        "INSERT INTO inventory_batch_items (
           batch_number, sku, total_quantity, add_to_quantity, current_price,
           product_line_id, set_id, product_id, original_row_json, created_at, updated_at)
         SELECT $1, item.sku, item.quantity, 0, item.current_price, item.product_line_id,
           item.set_id, item.product_id, item.row, $8, $8
         FROM UNNEST($2::int[], $3::int[], $4::float8[], $5::int[], $6::int[], $7::int[], $9::jsonb[])
           AS item(sku, quantity, current_price, product_line_id, set_id, product_id, row)",
    )
    .bind(batch_number)
    .bind(column(|i| i.sku))
    .bind(column(|i| i.quantity))
    .bind(items.iter().map(|i| i.current_price).collect::<Vec<_>>())
    .bind(column(|i| i.product_line_id))
    .bind(column(|i| i.set_id))
    .bind(column(|i| i.product_id))
    .bind(now)
    .bind(rows.iter().map(Json).collect::<Vec<_>>())
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO inventory_batch_pricing_jobs (batch_number, priority, mode, status, config_json)
         VALUES ($1, $2, $3, 'queued', $4::jsonb)",
    )
    .bind(batch_number)
    .bind(priority)
    .bind(mode)
    .bind(Json(queue.config))
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE continuous_pricing_inventory
         SET last_batch_number = $2,
             next_price_at = CASE WHEN $5 = 'cached' THEN (
               SELECT COALESCE((curve.pricing_details_json->>'marketDataAt')::timestamptz, curve.priced_at)
               FROM inventory_strategy_pricing_curves curve
               WHERE curve.seller_key = continuous_pricing_inventory.seller_key
                 AND curve.sku = continuous_pricing_inventory.sku
             ) ELSE NOW() END + ($3 * INTERVAL '1 minute'),
             updated_at = NOW()
         WHERE seller_key = $1 AND sku = ANY($4::int[])",
    )
    .bind(queue.seller)
    .bind(batch_number)
    .bind(queue.minimum_interval_minutes as f64)
    .bind(column(|i| i.sku))
    .bind(mode)
    .execute(&mut *conn)
    .await?;
    Ok(batch_number)
}

/// Holds the seller's scheduling to this transaction, so two schedulers queue one batch.
async fn lock(conn: &mut PgConnection, seller: &str) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("continuous-pricing:{seller}"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// What a scheduling did.
#[derive(Clone, Debug, PartialEq)]
pub enum Scheduled {
    /// A batch was queued.
    Batch {
        batch_number: i32,
        item_count: usize,
        priority: i32,
    },
    /// A continuous batch already waits at this priority.
    Backlogged,
}

/// Queues the SKUs due, priority ones alone when there are any, unless a batch already waits at
/// that priority; none when nothing is due (`scheduleDueBatch`). `conn` is in a transaction.
pub async fn schedule_due_batch(
    conn: &mut PgConnection,
    queue: &Queue<'_>,
    now: DateTime<Utc>,
) -> sqlx::Result<Option<Scheduled>> {
    lock(conn, queue.seller).await?;
    let priority_due: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM continuous_pricing_inventory
           WHERE {SCHEDULABLE} AND {PRIORITY_DUE})"
    ))
    .bind(queue.seller)
    .fetch_one(&mut *conn)
    .await?;
    let priority = if priority_due {
        priority::CONTINUOUS_PRIORITY
    } else {
        priority::CONTINUOUS_ROUTINE
    };
    let waiting: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM inventory_batch_pricing_jobs job
           JOIN inventory_batches batch ON batch.batch_number = job.batch_number
           WHERE job.status = 'queued' AND job.priority = $1 AND batch.source_type = 'continuous')",
    )
    .bind(priority)
    .fetch_one(&mut *conn)
    .await?;
    if waiting {
        return Ok(Some(Scheduled::Backlogged));
    }
    let only_priority = if priority_due {
        format!("AND {PRIORITY_DUE}")
    } else {
        String::new()
    };
    let items: Vec<Item> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM continuous_pricing_inventory
         WHERE {SCHEDULABLE} {only_priority}
         ORDER BY CASE WHEN {PRIORITY_DUE} THEN 0 ELSE 1 END, next_price_at, sku
         FOR UPDATE SKIP LOCKED
         LIMIT $2"
    ))
    .bind(queue.seller)
    .bind(queue.batch_size)
    .fetch_all(&mut *conn)
    .await?;
    if items.is_empty() {
        return Ok(None);
    }
    let batch_number = create_batch(conn, &items, queue, "full", priority, now).await?;
    Ok(Some(Scheduled::Batch {
        batch_number,
        item_count: items.len(),
        priority,
    }))
}

/// Makes every eligible SKU of the seller's due now (`makeEligibleInventoryDue`); how many.
pub async fn make_eligible_inventory_due(
    conn: &mut PgConnection,
    seller: &str,
) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "UPDATE continuous_pricing_inventory
         SET next_price_at = LEAST(next_price_at, NOW()), updated_at = NOW()
         WHERE seller_key = $1 AND enabled AND pricing_eligible AND in_stock AND quantity > 0
           AND pause_reason IS NULL",
    )
    .bind(seller)
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// What repricing from saved curves queued.
#[derive(Clone, Debug, PartialEq)]
pub struct Repriced {
    pub batch_numbers: Vec<i32>,
    /// SKUs repriced from their curves.
    pub cached_count: usize,
    /// Eligible SKUs left for a full pricing.
    pub refresh_count: usize,
}

/// Why repricing from saved curves was refused.
#[derive(Debug)]
pub enum Refused {
    AlreadyQueued,
    Failed(sqlx::Error),
}

impl From<sqlx::Error> for Refused {
    fn from(error: sqlx::Error) -> Self {
        Refused::Failed(error)
    }
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::AlreadyQueued => {
                f.write_str("Saved-curve repricing is already queued for this policy.")
            }
            Refused::Failed(error) => write!(f, "{error}"),
        }
    }
}

/// Makes every eligible SKU due and queues those with a reusable curve as `cached` batches at the
/// operator's priority (`scheduleCachedPolicyBatches`). `conn` is in a transaction.
pub async fn schedule_cached_policy_batches(
    conn: &mut PgConnection,
    queue: &Queue<'_>,
    now: DateTime<Utc>,
) -> Result<Repriced, Refused> {
    lock(conn, queue.seller).await?;
    let queued: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM inventory_batch_pricing_jobs job
           JOIN inventory_batches batch USING (batch_number)
           WHERE batch.source_type = 'continuous' AND batch.source_label = $1
             AND job.mode = 'cached' AND job.status IN ('queued', 'pricing')
             AND job.config_json = $2::jsonb)",
    )
    .bind(queue.seller)
    .bind(Json(queue.config))
    .fetch_one(&mut *conn)
    .await?;
    if queued {
        return Err(Refused::AlreadyQueued);
    }
    let eligible = make_eligible_inventory_due(conn, queue.seller).await? as usize;
    let reusable = REUSABLE.replace("$6::timestamptz", "NOW()");
    let items: Vec<Item> = sqlx::query_as(&format!(
        "SELECT {ITEM_COLUMNS} FROM continuous_pricing_inventory
         WHERE {SCHEDULABLE}
           AND EXISTS (
             SELECT 1 FROM inventory_strategy_pricing_curves curve
             WHERE curve.seller_key = continuous_pricing_inventory.seller_key
               AND curve.sku = continuous_pricing_inventory.sku
               AND {reusable})
         ORDER BY sku
         FOR UPDATE SKIP LOCKED"
    ))
    .bind(queue.seller)
    .bind(MODEL_VERSION)
    .bind(queue.minimum_interval_minutes as f64)
    .bind(Json(&queue.config["supplyAnalysis"]))
    .fetch_all(&mut *conn)
    .await?;
    let mut batch_numbers = Vec::new();
    for chunk in items.chunks(queue.batch_size.max(1) as usize) {
        batch_numbers
            .push(create_batch(conn, chunk, queue, "cached", priority::OPERATOR, now).await?);
    }
    Ok(Repriced {
        batch_numbers,
        cached_count: items.len(),
        refresh_count: eligible - items.len(),
    })
}

/// The pricing configuration a job is queued with now.
pub async fn job_config(db: &Database) -> sqlx::Result<Value> {
    let row: Option<(Value, Value, Value)> = sqlx::query_as(
        "SELECT pricing_json, supply_analysis_json, product_line_pricing_json
         FROM pricing_config WHERE config_key = 'default'",
    )
    .fetch_optional(&db.0)
    .await?;
    let (pricing, supply, lines) = row.unwrap_or_default();
    Ok(pricing_config::normalized(&pricing, &supply, &lines))
}

/// Whether the seller's inventory has not been refreshed within the interval.
pub async fn should_refresh(db: &Database, seller: &str, minutes: i64) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM continuous_pricing_refreshes
           WHERE seller_key = $1 AND status = 'completed'
             AND completed_at >= NOW() - ($2 * INTERVAL '1 minute'))",
    )
    .bind(seller)
    .bind(minutes as f64)
    .fetch_one(&db.0)
    .await
}

/// Records a refresh that failed, its message cut to a thousand characters.
pub async fn record_refresh_failure(db: &Database, seller: &str, why: &str) -> sqlx::Result<()> {
    // `slice(0, 1_000)` counts UTF-16 units, as JavaScript's strings do.
    let why = String::from_utf16_lossy(&why.encode_utf16().take(1_000).collect::<Vec<_>>());
    sqlx::query(
        "INSERT INTO continuous_pricing_refreshes (seller_key, status, error_message, completed_at)
         VALUES ($1, 'failed', $2, NOW())",
    )
    .bind(seller)
    .bind(why)
    .execute(&db.0)
    .await?;
    Ok(())
}

/// What a scheduler cycle did (`ContinuousPricingSchedulerResult`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cycle {
    Disabled,
    RefreshFailed,
    Idle,
    Backlogged,
    Scheduled {
        batch_number: i32,
        item_count: usize,
    },
}

/// One cycle: refresh the inventory when it is stale, then queue what is due.
pub async fn cycle(
    db: &Database,
    inventory: &impl SellerInventory,
    market: &impl MarketData,
) -> Result<(Cycle, Settings), String> {
    let failed = |e: sqlx::Error| e.to_string();
    let settings = store::settings(db).await.map_err(failed)?;
    if !settings.enabled || settings.seller_key.is_empty() {
        return Ok((Cycle::Disabled, settings));
    }
    let seller = &settings.seller_key;
    if should_refresh(db, seller, settings.inventory_refresh_minutes)
        .await
        .map_err(failed)?
        && let Err(why) = refresh::refresh(
            db,
            seller,
            settings.minimum_interval_minutes,
            inventory,
            market,
        )
        .await
    {
        record_refresh_failure(db, seller, &why)
            .await
            .map_err(failed)?;
        return Ok((Cycle::RefreshFailed, settings));
    }
    let config = job_config(db).await.map_err(failed)?;
    let mut tx = db.0.begin().await.map_err(failed)?;
    let scheduled = schedule_due_batch(&mut tx, &Queue::of(&settings, &config), Utc::now())
        .await
        .map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    let cycle = match scheduled {
        None => Cycle::Idle,
        Some(Scheduled::Backlogged) => Cycle::Backlogged,
        Some(Scheduled::Batch {
            batch_number,
            item_count,
            ..
        }) => Cycle::Scheduled {
            batch_number,
            item_count,
        },
    };
    Ok((cycle, settings))
}

/// How long a cycle waits before the next: at once after queueing a batch, the schedule's poll
/// otherwise, and never under a second.
fn pause(cycle: &Cycle, settings: &Settings) -> std::time::Duration {
    let seconds = match cycle {
        Cycle::Scheduled { .. } => 0,
        _ => settings.scheduler_poll_seconds,
    };
    std::time::Duration::from_millis((seconds.max(0) as u64 * 1_000).max(1_000))
}

/// Whether `CONTINUOUS_PRICING_SCHEDULER` turns the scheduler on: Node's scheduler queues the
/// batches until cutover, and both read the seller's inventory from TCGplayer.
pub fn on() -> bool {
    crate::config::is_set("CONTINUOUS_PRICING_SCHEDULER")
}

/// The app's task (`continuous-pricing-scheduler.server.ts`).
pub async fn run(db: Database, signal: corten::Signal) {
    println!("Continuous pricing scheduler started");
    let tcg = crate::tcgplayer::TcgPlayer::new(db.clone());
    let inventory = refresh::TcgPlayerSearch(tcg.clone());
    let market = crate::features::batch_pricing::market::TcgPlayerMarket(tcg);
    loop {
        if signal.is_aborted() {
            return;
        }
        // A cycle stops at shutdown: its writes are each a transaction, so none is left half done.
        let wait = tokio::select! {
            biased;
            _ = signal.aborted() => return,
            done = cycle(&db, &inventory, &market) => match done {
                Ok((cycle, settings)) => {
                    if let Cycle::Scheduled { batch_number, item_count } = cycle {
                        println!("Continuous pricing scheduler queued batch={batch_number} items={item_count}");
                    }
                    pause(&cycle, &settings)
                }
                Err(why) => {
                    eprintln!("Continuous pricing scheduler cycle failed: {why}");
                    std::time::Duration::from_secs(30)
                }
            },
        };
        tokio::select! {
            biased;
            _ = signal.aborted() => return,
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn the_next_cycle_comes_at_once_after_a_batch_and_at_the_poll_otherwise() {
        let settings = Settings {
            scheduler_poll_seconds: 45,
            ..Settings::default()
        };
        let queued = Cycle::Scheduled {
            batch_number: 1,
            item_count: 2,
        };
        assert_eq!(pause(&queued, &settings).as_millis(), 1_000);
        assert_eq!(pause(&Cycle::Idle, &settings).as_secs(), 45);
    }

    #[test]
    fn a_batch_item_s_row_writes_prices_as_javascript_does() {
        let item = Item {
            sku: 7,
            product_id: 1,
            product_line_id: 3,
            set_id: 2,
            product_line: "Pokemon".into(),
            set_name: "Base".into(),
            product_name: "Pikachu".into(),
            condition: "Near Mint".into(),
            variant: "Holofoil".into(),
            quantity: 2,
            current_price: Some(1.5),
            market_price: None,
        };
        let row = original_row(&item);
        assert_eq!(row["TCG Marketplace Price"], "1.5");
        assert_eq!(row["TCG Market Price"], "");
        assert_eq!(row["Total Quantity"], "2");
    }

    /// What a scheduling wrote, its batches numbered from 0 so two runs compare.
    fn renumbered(mut captured: Value) -> Value {
        let mut order = BTreeMap::new();
        for batch in captured["batches"].as_array().unwrap() {
            let n = batch["batch"].as_i64().unwrap();
            let next = order.len() as i64;
            order.entry(n).or_insert(next);
        }
        for list in ["batches", "items", "jobs", "inventory"] {
            for entry in captured[list].as_array_mut().unwrap() {
                if let Some(n) = entry["batch"].as_i64() {
                    entry["batch"] = order.get(&n).copied().map_or(Value::Null, Value::from);
                }
            }
        }
        captured
    }

    /// Node's scheduling on dev (`.port-logs/scheduler-node.ts`: what is due now, saved-curve
    /// repricing at the schedule's interval, and at sixty days so curves are reused), each in a
    /// transaction rolled back after reading what it wrote; then the same here. The batches, their
    /// items and rows, the jobs and their configuration, and every SKU's schedule match.
    #[tokio::test]
    #[ignore = "uses the dev database in transactions rolled back, and Node's run in .port-logs"]
    async fn scheduling_queues_what_node_s_queues() {
        crate::config::load_env();
        let db = Database::connect_lazy(&crate::config::database_url());
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/scheduler.node.json").unwrap(),
        )
        .unwrap();
        let capture = std::fs::read_to_string(".port-logs/scheduler-capture.sql").unwrap();
        let base = node["base"].as_i64().unwrap() as i32;
        let settings = store::settings(&db).await.unwrap();
        let config = job_config(&db).await.unwrap();
        let wide = Settings {
            minimum_interval_minutes: 60 * 24 * 60,
            ..settings.clone()
        };
        let mut ours = Vec::new();
        for (scenario, settings) in [("due", &settings), ("cached", &settings), ("wide", &wide)] {
            let mut tx = db.0.begin().await.unwrap();
            let queue = Queue::of(settings, &config);
            let said = if scenario == "due" {
                format!(
                    "{:?}",
                    schedule_due_batch(&mut tx, &queue, Utc::now())
                        .await
                        .unwrap()
                )
            } else {
                format!(
                    "{:?}",
                    schedule_cached_policy_batches(&mut tx, &queue, Utc::now())
                        .await
                        .unwrap()
                )
            };
            println!("{scenario}: {said}");
            let captured: Value = sqlx::query_scalar(&capture)
                .bind(base)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            tx.rollback().await.unwrap();
            ours.push(captured);
        }
        let mut differences = Vec::new();
        for (i, (ours, theirs)) in ours
            .into_iter()
            .zip(node["captured"].as_array().unwrap())
            .enumerate()
        {
            let (ours, theirs) = (renumbered(ours), renumbered(theirs.clone()));
            for list in ["batches", "items", "jobs"] {
                if ours[list] != theirs[list] {
                    differences.push(format!(
                        "scenario {i} {list}: {} here, {} by Node",
                        ours[list].as_array().unwrap().len(),
                        theirs[list].as_array().unwrap().len()
                    ));
                }
            }
            let (a, b) = (
                ours["inventory"].as_array().unwrap(),
                theirs["inventory"].as_array().unwrap(),
            );
            if a.len() != b.len() {
                differences.push(format!(
                    "scenario {i} inventory: {} here, {} by Node",
                    a.len(),
                    b.len()
                ));
            }
            for (x, y) in a.iter().zip(b) {
                let same_time = x["next"] == y["next"]
                    || (x["fromNow"].as_f64().unwrap() - y["fromNow"].as_f64().unwrap()).abs()
                        < 1.0;
                if x["sku"] != y["sku"] || x["batch"] != y["batch"] || !same_time {
                    differences.push(format!("scenario {i} inventory: {x} here, {y} by Node"));
                    break;
                }
            }
        }
        for d in &differences {
            println!("{d}");
        }
        assert!(differences.is_empty());
    }
}
