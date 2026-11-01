//! Plans the publication an intake run queued to publish once its pricing ends
//! (`planNextQueuedIntakePublication`), in the worker's turn and in one transaction with the run:
//! only the database is written here, Seller Portal later by the worker.
//!
//! A run whose pricing failed or was run again, or whose seller is no longer the one publications
//! go to, is left for review. A plan that fails is tried again a minute later, and after three
//! attempts left for review.
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{Connection, PgConnection};

use super::{
    plan::{self, Configuration},
    preview,
};
use crate::features::continuous_pricing::store::Settings as Schedule;

#[derive(sqlx::FromRow)]
struct Run {
    request_id: String,
    batch_number: i32,
    pricing_job_id: String,
    seller_key: String,
    pricing_status: String,
}

/// Where the run's planning ends, and why when a person must look.
type Planning = (&'static str, Option<&'static str>);

const STALE: &str = "Pricing failed, was run again, or the publication seller changed. Review this batch before publishing.";
const NONE_ELIGIBLE: &str =
    "No eligible results. Open the batch to review pricing and publication exclusions.";

async fn planned(
    conn: &mut PgConnection,
    run: &Run,
    now: DateTime<Utc>,
) -> Result<Planning, String> {
    let failed = |e: sqlx::Error| e.to_string();
    sqlx::query("SELECT batch_number FROM inventory_batches WHERE batch_number = $1 FOR UPDATE")
        .bind(run.batch_number)
        .execute(&mut *conn)
        .await
        .map_err(failed)?;
    let loaded = preview::load(conn, run.batch_number)
        .await
        .map_err(failed)?;
    let stored: Option<Value> = sqlx::query_scalar(
        "SELECT settings_json -> 'continuousPricing' FROM inventory_publication_settings
         WHERE config_key = 'default'",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(failed)?
    .flatten();
    let seller = Schedule::of(&stored.unwrap_or(Value::Null)).seller_key;
    let latest_job = loaded
        .as_ref()
        .and_then(|(batch, _, _)| batch.job_id)
        .map(|id| id.to_string());
    let Some((batch, items, results)) = loaded.filter(|_| {
        run.pricing_status != "failed"
            && latest_job.as_deref() == Some(&run.pricing_job_id)
            && seller == run.seller_key
    }) else {
        return Ok(("needs_review", Some(STALE)));
    };
    let configuration = Configuration::load(conn).await.map_err(failed)?;
    let policy = &configuration.policy;
    let known = preview::known(conn, run.batch_number, &items, &results, None)
        .await
        .map_err(failed)?;
    let preview = preview::preview(&batch, &items, &results, &known, policy, now, false)?;
    if preview.eligible_count == 0 {
        return Ok(("needs_review", Some(NONE_ELIGIBLE)));
    }
    let publications =
        plan::manual(&preview, policy, None, Some(&run.seller_key)).map_err(|e| e.to_string())?;
    for publication in &publications {
        plan::create_or_find(conn, publication)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(("planned", None))
}

/// Plans the oldest run waiting whose pricing ended, if any.
pub async fn plan_next(conn: &mut PgConnection, now: DateTime<Utc>) -> sqlx::Result<()> {
    let mut tx = conn.begin().await?;
    let run: Option<Run> = sqlx::query_as(
        "SELECT r.request_id, r.batch_number, r.pricing_job_id::text AS pricing_job_id, r.seller_key,
                j.status AS pricing_status
         FROM inventory_intake_runs r JOIN inventory_batch_pricing_jobs j ON j.id = r.pricing_job_id
         WHERE r.workflow = 'publish' AND r.planning_status = 'waiting'
           AND r.next_attempt_at <= NOW() AND j.status IN ('completed', 'failed')
         ORDER BY r.created_at FOR UPDATE OF r SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(run) = run else {
        return tx.commit().await;
    };
    let mut attempt = tx.begin().await?;
    match planned(&mut attempt, &run, now).await {
        Ok((status, error)) => {
            sqlx::query(
                "UPDATE inventory_intake_runs SET planning_status = $2, planning_error = $3
                 WHERE request_id = $1",
            )
            .bind(&run.request_id)
            .bind(status)
            .bind(error)
            .execute(&mut *attempt)
            .await?;
            attempt.commit().await?;
        }
        Err(why) => {
            attempt.rollback().await?;
            sqlx::query(
                "UPDATE inventory_intake_runs SET planning_error = $2,
                   planning_attempts = planning_attempts + 1,
                   planning_status = CASE WHEN planning_attempts >= 2 THEN 'needs_review' ELSE 'waiting' END,
                   next_attempt_at = NOW() + INTERVAL '1 minute'
                 WHERE request_id = $1",
            )
            .bind(&run.request_id)
            .bind(why)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await
}
