//! The seller order history in Postgres, ported from `sellerOrderHistory.server.ts`: a scan's run
//! (claimed, checkpointed, finished or started over) and each order read from the API recorded as
//! a revision when it changed, its lines replaced and its SKUs queued for FIFO replay.
//!
//! Every call is a transaction of its own on the store's connection (a savepoint when the
//! connection is already in one). Calls take turns on the connection, so details read
//! concurrently are recorded one after another.
use std::{
    collections::{HashMap, HashSet},
    ops::DerefMut,
};

use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
use tokio::sync::Mutex;

use super::{
    observation::{self, Observation},
    sync::{Coverage, Gap, Progress, Run, Store},
};
use crate::features::{inventory_economics::ledger::fingerprint::js_float, inventory_fifo::queue};

const LEASE_LOST: &str = "Seller order sync lease was lost.";

const RUN_COLUMNS: &str = "id,status,next_offset,expected_total,pages_completed,orders_observed,
  details_recorded,gaps::text AS gaps,error";

#[derive(sqlx::FromRow)]
struct RunRow {
    id: i64,
    status: String,
    next_offset: i32,
    expected_total: Option<i32>,
    pages_completed: i32,
    orders_observed: i32,
    details_recorded: i32,
    gaps: String,
    error: Option<String>,
}

impl RunRow {
    fn gaps(&self) -> Result<Vec<Gap>, String> {
        serde_json::from_str(&self.gaps).map_err(|e| format!("a run's gaps did not read: {e}"))
    }

    fn run(&self) -> Result<Run, String> {
        Ok(Run {
            id: self.id,
            next_offset: self.next_offset.max(0) as u32,
            expected_total: self.expected_total.map(|t| t.max(0) as u32),
            pages_completed: self.pages_completed.max(0) as u32,
            gaps: self.gaps()?,
        })
    }

    fn coverage(&self) -> Result<Coverage, String> {
        Ok(Coverage {
            status: self.status.clone(),
            orders_observed: self.orders_observed.max(0) as u32,
            details_recorded: self.details_recorded.max(0) as u32,
            next_offset: self.next_offset.max(0) as u32,
            expected_total: self.expected_total.map(|t| t.max(0) as u32),
            gaps: self.gaps()?,
            error: self.error.clone(),
        })
    }
}

/// A JSON value with every whole number written as JavaScript writes it (`2`, not `2.0`), so
/// evidence stored as JSONB reads back as Node's does.
fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => {
                Value::from(f as i64)
            }
            _ => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(js_json).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), js_json(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A text column from an observed field: a string as it is, anything else as JSON writes it.
fn text(value: &Option<Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// A money amount as JavaScript would write it into a numeric column.
fn amount(value: f64) -> String {
    js_float(value)
}

fn transaction_amount(observation: &Observation, key: &str) -> Option<String> {
    observation
        .transaction
        .as_ref()
        .ok()
        .and_then(|t| t.get(key))
        .and_then(Value::as_f64)
        .map(amount)
}

fn transaction_evidence(observation: &Observation) -> String {
    match &observation.transaction {
        Ok(transaction) => js_json(transaction).to_string(),
        Err(reason) => json!({ "coverageReason": reason }).to_string(),
    }
}

/// `recordObservation` for an order read from the API: whether it changed the history, and the
/// order's id.
pub async fn record_observation(
    conn: &mut PgConnection,
    o: &Observation,
) -> Result<(bool, String), String> {
    let failed = |e: sqlx::Error| e.to_string();
    let existing: Option<(String, String, i32)> = sqlx::query_as(
        "SELECT id::text,source_fingerprint,source_revision FROM seller_orders
         WHERE seller_key=$1 AND order_number=$2 FOR UPDATE",
    )
    .bind(&o.seller_key)
    .bind(&o.order_number)
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?;
    if let Some((id, fingerprint, _)) = &existing
        && *fingerprint == o.fingerprint
    {
        sqlx::query(
            "UPDATE seller_orders SET
               summary_order_time=COALESCE($3::timestamptz,summary_order_time),
               summary_fingerprint=COALESCE($4,summary_fingerprint),
               last_observed_at=GREATEST(last_observed_at,$2::timestamptz),
               detail_observed_at=GREATEST(detail_observed_at,$2::timestamptz),
               latest_source='tcgplayer_api'
             WHERE id=$1::bigint",
        )
        .bind(id)
        .bind(&o.observed_at)
        .bind(&o.summary_order_time)
        .bind(&o.summary_fingerprint)
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
        return Ok((false, id.clone()));
    }
    let revision = existing.as_ref().map_or(0, |(_, _, r)| *r) + 1;
    let order_id = match existing {
        Some((id, _, _)) => {
            sqlx::query(
                "UPDATE seller_orders SET
                   order_time=$2::timestamptz,summary_order_time=COALESCE($3::timestamptz,summary_order_time),
                   lifecycle=$4,provider_status=$5,refund_status=$6,order_channel=$7,order_fulfillment=$8,
                   gross_item_proceeds=$9::numeric,gross_shipping_proceeds=$10::numeric,
                   gross_order_proceeds=$11::numeric,platform_fee_amount=$12::numeric,
                   provider_net_proceeds=$13::numeric,direct_fee_amount=$14::numeric,
                   transaction_evidence=$15::jsonb,source_revision=$16,source_fingerprint=$17,
                   summary_fingerprint=COALESCE($18,summary_fingerprint),
                   last_observed_at=$19::timestamptz,detail_observed_at=$19::timestamptz,latest_source='tcgplayer_api'
                 WHERE id=$1::bigint",
            )
            .bind(&id)
            .bind(&o.order_time)
            .bind(&o.summary_order_time)
            .bind(o.lifecycle)
            .bind(&o.provider_status)
            .bind(text(&o.refund_status))
            .bind(text(&o.order_channel))
            .bind(text(&o.order_fulfillment))
            .bind(amount(o.gross_item_proceeds))
            .bind(transaction_amount(o, "shippingAmount"))
            .bind(transaction_amount(o, "grossAmount"))
            .bind(transaction_amount(o, "feeAmount"))
            .bind(transaction_amount(o, "netAmount"))
            .bind(transaction_amount(o, "directFeeAmount"))
            .bind(transaction_evidence(o))
            .bind(revision)
            .bind(&o.fingerprint)
            .bind(&o.summary_fingerprint)
            .bind(&o.observed_at)
            .execute(&mut *conn)
            .await
            .map_err(failed)?;
            sqlx::query("DELETE FROM seller_order_lines WHERE order_id=$1::bigint")
                .bind(&id)
                .execute(&mut *conn)
                .await
                .map_err(failed)?;
            id
        }
        None => sqlx::query_scalar(
            "INSERT INTO seller_orders (
               seller_key,order_number,order_time,summary_order_time,lifecycle,provider_status,refund_status,
               order_channel,order_fulfillment,gross_item_proceeds,gross_shipping_proceeds,gross_order_proceeds,
               platform_fee_amount,provider_net_proceeds,direct_fee_amount,transaction_evidence,
               source_revision,source_fingerprint,summary_fingerprint,
               first_observed_at,last_observed_at,detail_observed_at,latest_source
             ) VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10::numeric,$11::numeric,$12::numeric,
               $13::numeric,$14::numeric,$15::numeric,$16::jsonb,1,$17,$18,
               $19::timestamptz,$19::timestamptz,$19::timestamptz,'tcgplayer_api')
             RETURNING id::text",
        )
        .bind(&o.seller_key)
        .bind(&o.order_number)
        .bind(&o.order_time)
        .bind(&o.summary_order_time)
        .bind(o.lifecycle)
        .bind(&o.provider_status)
        .bind(text(&o.refund_status))
        .bind(text(&o.order_channel))
        .bind(text(&o.order_fulfillment))
        .bind(amount(o.gross_item_proceeds))
        .bind(transaction_amount(o, "shippingAmount"))
        .bind(transaction_amount(o, "grossAmount"))
        .bind(transaction_amount(o, "feeAmount"))
        .bind(transaction_amount(o, "netAmount"))
        .bind(transaction_amount(o, "directFeeAmount"))
        .bind(transaction_evidence(o))
        .bind(&o.fingerprint)
        .bind(&o.summary_fingerprint)
        .bind(&o.observed_at)
        .fetch_one(&mut *conn)
        .await
        .map_err(failed)?,
    };
    for line in observation::aggregate_lines(&o.lines)? {
        sqlx::query(
            "INSERT INTO seller_order_lines (order_id,sku_id,product_id,product_name,ordered_quantity,gross_item_proceeds)
             VALUES ($1::bigint,$2,$3,$4,$5,$6::numeric)",
        )
        .bind(&order_id)
        .bind(&line.sku_id)
        .bind(Some(&line.product_id).filter(|p| !p.is_empty()))
        .bind(&line.name)
        .bind(line.quantity as i32)
        .bind(amount(line.extended_price))
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    }
    let lines = Value::Array(o.lines.iter().map(observation::Line::json).collect());
    sqlx::query(
        "INSERT INTO seller_order_revisions (
           order_id,revision_number,source_fingerprint,source,observed_at,order_time,order_time_evidence,
           summary_order_time,provider_status,lifecycle,refund_status,refund_evidence,line_evidence,transaction_evidence
         ) VALUES ($1::bigint,$2,$3,'tcgplayer_api',$4::timestamptz,$5::timestamptz,'detail_canonical',
           $6::timestamptz,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb)",
    )
    .bind(&order_id)
    .bind(revision)
    .bind(&o.fingerprint)
    .bind(&o.observed_at)
    .bind(&o.order_time)
    .bind(&o.summary_order_time)
    .bind(&o.provider_status)
    .bind(o.lifecycle)
    .bind(text(&o.refund_status))
    .bind(js_json(&Value::Array(o.refunds.clone())).to_string())
    .bind(js_json(&lines).to_string())
    .bind(transaction_evidence(o))
    .execute(&mut *conn)
    .await
    .map_err(failed)?;
    queue::enqueue_order_revision(conn, &order_id).await?;
    Ok((true, order_id))
}

/// The history kept in Postgres, on one connection.
pub struct Postgres<C> {
    conn: Mutex<C>,
}

impl<C> Postgres<C> {
    pub fn new(conn: C) -> Self {
        Postgres {
            conn: Mutex::new(conn),
        }
    }
}

fn failed(e: sqlx::Error) -> String {
    e.to_string()
}

async fn find_run(
    conn: &mut PgConnection,
    sql: &str,
    run: &Run,
    claim: &str,
) -> Result<RunRow, String> {
    sqlx::query_as::<_, RunRow>(sql)
        .bind(run.id)
        .bind(claim)
        .fetch_optional(&mut *conn)
        .await
        .map_err(failed)?
        .ok_or_else(|| LEASE_LOST.to_owned())
}

/// `Date.parse` succeeds for the times a search result or detail carries.
fn parses(time: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(time).is_ok()
        || chrono::NaiveDateTime::parse_from_str(time, "%Y-%m-%dT%H:%M:%S%.f").is_ok()
}

impl<C: DerefMut<Target = PgConnection> + Send> Store for Postgres<C> {
    async fn start_or_resume(&self, seller: &str, claim: &str) -> Result<Option<Run>, String> {
        let seller = seller.trim();
        let mut conn = self.conn.lock().await;
        let mut tx = conn.begin().await.map_err(failed)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("seller-order-sync:{seller}"))
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
        sqlx::query(
            "UPDATE seller_order_sync_runs SET status='incomplete',
               error=COALESCE(error,'Previous sync stopped before its checkpoint.'),
               claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
             WHERE seller_key=$1 AND source='tcgplayer_api' AND status='running' AND claim_expires_at<NOW()",
        )
        .bind(seller)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
        let existing: Option<RunRow> = sqlx::query_as(&format!(
            "SELECT {RUN_COLUMNS} FROM seller_order_sync_runs
             WHERE seller_key=$1 AND source='tcgplayer_api' AND status IN ('running','incomplete') FOR UPDATE"
        ))
        .bind(seller)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
        let row: RunRow = match existing {
            Some(row) if row.status == "running" => {
                tx.commit().await.map_err(failed)?;
                return Ok(None);
            }
            Some(row) => sqlx::query_as(&format!(
                "UPDATE seller_order_sync_runs SET status='running',error=NULL,claim_token=$2::uuid,
                   claim_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW()
                 WHERE id=$1 RETURNING {RUN_COLUMNS}"
            ))
            .bind(row.id)
            .bind(claim)
            .fetch_one(&mut *tx)
            .await
            .map_err(failed)?,
            None => sqlx::query_as(&format!(
                "INSERT INTO seller_order_sync_runs (seller_key,source,status,search_range,claim_token,claim_expires_at)
                 VALUES ($1,'tcgplayer_api','running','LastThreeMonths',$2::uuid,NOW()+INTERVAL '2 minutes')
                 RETURNING {RUN_COLUMNS}"
            ))
            .bind(seller)
            .bind(claim)
            .fetch_one(&mut *tx)
            .await
            .map_err(failed)?,
        };
        tx.commit().await.map_err(failed)?;
        row.run().map(Some)
    }

    async fn coverage(&self, seller: &str) -> Result<Coverage, String> {
        let mut conn = self.conn.lock().await;
        let row: Option<RunRow> = sqlx::query_as(&format!(
            "SELECT {RUN_COLUMNS} FROM seller_order_sync_runs
             WHERE seller_key=$1 AND source='tcgplayer_api' ORDER BY started_at DESC,id DESC LIMIT 1"
        ))
        .bind(seller.trim())
        .fetch_optional(&mut **conn)
        .await
        .map_err(failed)?;
        match row {
            Some(row) => row.coverage(),
            None => Ok(Coverage {
                status: "not_started".into(),
                orders_observed: 0,
                details_recorded: 0,
                next_offset: 0,
                expected_total: None,
                gaps: Vec::new(),
                error: None,
            }),
        }
    }

    async fn record(
        &self,
        run: &Run,
        claim: &str,
        observation: &Observation,
    ) -> Result<bool, String> {
        let mut conn = self.conn.lock().await;
        let mut tx = conn.begin().await.map_err(failed)?;
        find_run(
            &mut tx,
            "SELECT id,status,next_offset,expected_total,pages_completed,orders_observed,details_recorded,
               gaps::text AS gaps,error FROM seller_order_sync_runs
             WHERE id=$1 AND claim_token=$2::uuid AND status='running' AND claim_expires_at>NOW() FOR UPDATE",
            run,
            claim,
        )
        .await?;
        let (changed, _) = record_observation(&mut tx, observation).await?;
        sqlx::query(
            "UPDATE seller_order_sync_runs SET claim_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW()
             WHERE id=$1 AND claim_token=$2::uuid",
        )
        .bind(run.id)
        .bind(claim)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
        tx.commit().await.map_err(failed)?;
        Ok(changed)
    }

    async fn details_needed(
        &self,
        seller: &str,
        summaries: &[(String, String)],
    ) -> Result<HashSet<String>, String> {
        if summaries.is_empty() {
            return Ok(HashSet::new());
        }
        let numbers: Vec<&str> = summaries.iter().map(|(n, _)| n.as_str()).collect();
        let mut conn = self.conn.lock().await;
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT order_number,summary_fingerprint FROM seller_orders
             WHERE seller_key=$1 AND order_number=ANY($2::text[])",
        )
        .bind(seller.trim())
        .bind(&numbers)
        .fetch_all(&mut **conn)
        .await
        .map_err(failed)?;
        let held: HashMap<String, Option<String>> = rows.into_iter().collect();
        Ok(summaries
            .iter()
            .filter(|(n, fp)| observation::needs_detail(held.get(n).map(|s| s.as_deref()), fp))
            .map(|(n, _)| n.clone())
            .collect())
    }

    async fn api_verified(
        &self,
        seller: &str,
        numbers: &[String],
    ) -> Result<HashSet<String>, String> {
        if numbers.is_empty() {
            return Ok(HashSet::new());
        }
        let mut conn = self.conn.lock().await;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT order_number FROM seller_orders
             WHERE seller_key=$1 AND latest_source='tcgplayer_api' AND order_number=ANY($2::text[])",
        )
        .bind(seller.trim())
        .bind(numbers)
        .fetch_all(&mut **conn)
        .await
        .map_err(failed)?;
        Ok(rows.into_iter().collect())
    }

    async fn save_progress(&self, p: Progress<'_>) -> Result<Coverage, String> {
        let mut bounds: Vec<&String> = p.observed_times.iter().filter(|t| parses(t)).collect();
        bounds.sort();
        let mut conn = self.conn.lock().await;
        let mut tx = conn.begin().await.map_err(failed)?;
        let owned: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT status,claim_token::text FROM seller_order_sync_runs WHERE id=$1",
        )
        .bind(p.run.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
        if !owned
            .is_some_and(|(status, token)| status == "running" && token.as_deref() == Some(p.claim))
        {
            return Err(LEASE_LOST.into());
        }
        let first = p.page_offset.unwrap_or(p.next_offset);
        for (index, number) in p.order_numbers.iter().flatten().enumerate() {
            sqlx::query(
                "INSERT INTO seller_order_sync_run_orders (run_id,order_number,first_offset)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            )
            .bind(p.run.id)
            .bind(number)
            .bind((first as usize + index) as i32)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
        }
        let unique: i32 = sqlx::query_scalar(
            "SELECT COUNT(*)::int FROM seller_order_sync_run_orders WHERE run_id=$1",
        )
        .bind(p.run.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?;
        let gaps = serde_json::to_string(&js_json(
            &serde_json::to_value(p.gaps).map_err(|e| e.to_string())?,
        ))
        .map_err(|e| e.to_string())?;
        let row: Option<RunRow> = sqlx::query_as(&format!(
            "UPDATE seller_order_sync_runs SET
               next_offset=$3,expected_total=$4,
               pages_completed=pages_completed+CASE WHEN $5 THEN 1 ELSE 0 END,
               orders_observed=$6,details_recorded=details_recorded+$7,
               observed_from=CASE WHEN $8::timestamptz IS NULL THEN observed_from
                 ELSE LEAST(COALESCE(observed_from,$8::timestamptz),$8::timestamptz) END,
               observed_through=CASE WHEN $9::timestamptz IS NULL THEN observed_through
                 ELSE GREATEST(COALESCE(observed_through,$9::timestamptz),$9::timestamptz) END,
               gaps=$10::jsonb,error=NULL,claim_expires_at=NOW()+INTERVAL '2 minutes',updated_at=NOW()
             WHERE id=$1 AND claim_token=$2::uuid AND status='running'
             RETURNING {RUN_COLUMNS}"
        ))
        .bind(p.run.id)
        .bind(p.claim)
        .bind(p.next_offset as i32)
        .bind(p.expected_total.map(|t| t as i32))
        .bind(p.page_completed)
        .bind(unique)
        .bind(p.detail_count as i32)
        .bind(bounds.first().map(|t| t.as_str()))
        .bind(bounds.last().map(|t| t.as_str()))
        .bind(gaps)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
        let row = row.ok_or_else(|| LEASE_LOST.to_owned())?;
        tx.commit().await.map_err(failed)?;
        row.coverage()
    }

    async fn finish(
        &self,
        run: &Run,
        claim: &str,
        complete: bool,
        error: Option<&str>,
    ) -> Result<Coverage, String> {
        let mut conn = self.conn.lock().await;
        let mut tx = conn.begin().await.map_err(failed)?;
        let row: RunRow = sqlx::query_as(&format!(
            "UPDATE seller_order_sync_runs SET status=$3,
               finished_at=CASE WHEN $3='complete' THEN NOW() ELSE NULL END,
               error=$4,claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
             WHERE id=$1 AND claim_token=$2::uuid AND status='running'
             RETURNING {RUN_COLUMNS}"
        ))
        .bind(run.id)
        .bind(claim)
        .bind(if complete { "complete" } else { "incomplete" })
        .bind(error)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?
        .ok_or_else(|| LEASE_LOST.to_owned())?;
        if complete {
            sqlx::query("DELETE FROM seller_order_sync_run_orders WHERE run_id=$1")
                .bind(run.id)
                .execute(&mut *tx)
                .await
                .map_err(failed)?;
            sqlx::query(
                "DELETE FROM seller_order_sync_runs
                 WHERE seller_key=(SELECT seller_key FROM seller_order_sync_runs WHERE id=$1)
                   AND source='tcgplayer_api' AND status='complete'
                   AND id NOT IN (
                     SELECT id FROM seller_order_sync_runs
                     WHERE seller_key=(SELECT seller_key FROM seller_order_sync_runs WHERE id=$1)
                       AND source='tcgplayer_api' AND status='complete'
                     ORDER BY finished_at DESC,id DESC LIMIT 30)",
            )
            .bind(run.id)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
        }
        tx.commit().await.map_err(failed)?;
        row.coverage()
    }

    async fn restart(&self, run: &Run, claim: &str, error: &str) -> Result<Coverage, String> {
        let mut conn = self.conn.lock().await;
        let mut tx = conn.begin().await.map_err(failed)?;
        find_run(
            &mut tx,
            "SELECT id,status,next_offset,expected_total,pages_completed,orders_observed,details_recorded,
               gaps::text AS gaps,error FROM seller_order_sync_runs
             WHERE id=$1 AND claim_token=$2::uuid AND status='running' FOR UPDATE",
            run,
            claim,
        )
        .await?;
        sqlx::query("DELETE FROM seller_order_sync_run_orders WHERE run_id=$1")
            .bind(run.id)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
        let row: RunRow = sqlx::query_as(&format!(
            "UPDATE seller_order_sync_runs SET status='incomplete',next_offset=0,expected_total=NULL,
               pages_completed=0,orders_observed=0,error=$3,claim_token=NULL,claim_expires_at=NULL,updated_at=NOW()
             WHERE id=$1 AND claim_token=$2::uuid RETURNING {RUN_COLUMNS}"
        ))
        .bind(run.id)
        .bind(claim)
        .bind(error)
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?;
        tx.commit().await.map_err(failed)?;
        row.coverage()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        database::Database,
        features::seller_order_history::{
            fixtures::RecordedOrders,
            sync::{Budget, synchronize},
        },
    };

    /// Two steps of the sync over the recorded orders for seller `fixture-seller`, in a transaction
    /// on the dev database that is rolled back, compared with what Node's `synchronizeSellerOrders`
    /// answered and wrote from the same answers (`.port-logs/order-sync-node.ts`, captured by
    /// `.port-logs/order-sync-capture.sql`).
    #[tokio::test]
    #[ignore = "writes the dev database in a transaction it rolls back"]
    async fn synchronizes_as_node_does() {
        crate::config::load_env();
        let node: Value = serde_json::from_str(
            &std::fs::read_to_string(".port-logs/order-sync.node.json").unwrap(),
        )
        .unwrap();
        let capture = std::fs::read_to_string(".port-logs/order-sync-capture.sql").unwrap();
        let orders = RecordedOrders::new();
        let priority = orders.found_numbers();
        let budget = Budget {
            detail_concurrency: 1,
            ..Budget::default()
        };
        let now = || "2026-10-30T12:00:00.000Z".to_owned();
        let db = Database::connect_lazy(&crate::config::database_url());
        let mut tx = db.0.begin().await.unwrap();
        let mut steps = Vec::new();
        {
            let store = Postgres::new(&mut *tx);
            for claim in [
                "00000000-0000-4000-8000-000000000001",
                "00000000-0000-4000-8000-000000000002",
            ] {
                let synced = synchronize(
                    &orders,
                    &store,
                    "fixture-seller",
                    budget,
                    &priority,
                    claim,
                    &now,
                )
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
        }
        let captured: String =
            sqlx::query_scalar(&format!("SELECT captured::text FROM ({capture}) AS c"))
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        tx.rollback().await.unwrap();
        let captured: Value = serde_json::from_str(&captured).unwrap();
        println!(
            "{} orders, {} runs, {} SKUs queued",
            captured["orders"].as_array().map_or(0, Vec::len),
            captured["runs"].as_array().map_or(0, Vec::len),
            captured["queue"].as_array().map_or(0, Vec::len),
        );
        assert_eq!(Value::Array(steps), node["steps"]);
        for (index, (ours, theirs)) in captured["orders"]
            .as_array()
            .unwrap()
            .iter()
            .zip(node["captured"]["orders"].as_array().unwrap())
            .enumerate()
        {
            assert_eq!(ours, theirs, "order {index}");
        }
        assert_eq!(captured, node["captured"]);
    }
}
