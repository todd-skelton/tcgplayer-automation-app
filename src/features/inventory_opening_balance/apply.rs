//! Applying an opening balance, ported from `applyInventoryOpeningBalance.server.ts` and the
//! repository's `findApplicationReplay` and `apply`. An application already committed for the same
//! request and fingerprint answers again without reading Seller Portal. Otherwise the seller's
//! inventory is observed again (a fresh pair of exports), the order history moves one bounded
//! step, and the previewed run is applied under the seller's locks only when that observation
//! still matches the preview, no change awaits review, order coverage reaches past it, nothing
//! sold or went live while it was taken, and the preview's evidence is unchanged. Each positive
//! SKU with catalog identity becomes an opening receipt ahead of every other in FIFO, and the
//! seller's affected SKUs are queued for replay.
//!
//! Failures are Node's `String(error)`, as [`super::capture`]'s are.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};

use super::{
    capture::{self, Capture, Portal, thrown},
    preview,
};
use crate::{
    features::{
        inventory_fifo::queue,
        seller_order_history::{
            api::OrderManagement,
            store::Postgres,
            sync::{self, Budget},
            worker::iso_now,
        },
    },
    node_pg,
    tcgplayer::TcgPlayer,
};

/// What an application is asked for.
pub struct Application<'a> {
    pub request_id: &'a str,
    pub run_id: &'a str,
    pub evidence_fingerprint: &'a str,
    pub seller: &'a str,
}

/// Moving the seller's order history on before an application checks its coverage.
#[allow(async_fn_in_trait, reason = "used generically within this crate")]
pub trait OrderHistory {
    async fn catch_up(&self, conn: &mut PgConnection, seller: &str) -> Result<(), String>;
}

/// TCGplayer's order management API, one step of the scan within four pages.
pub struct TcgPlayerOrders<'a>(pub &'a TcgPlayer);

impl OrderHistory for TcgPlayerOrders<'_> {
    async fn catch_up(&self, conn: &mut PgConnection, seller: &str) -> Result<(), String> {
        let claim: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
            .fetch_one(&mut *conn)
            .await
            .map_err(node_pg::thrown)?;
        let budget = Budget {
            max_pages: 4,
            max_details: 25,
            page_size: 500,
            detail_concurrency: 5,
        };
        let store = Postgres::new(conn);
        let orders = OrderManagement(self.0);
        sync::synchronize(&orders, &store, seller, budget, &[], &claim, &iso_now)
            .await
            .map(|_| ())
            .map_err(|e| thrown(&e))
    }
}

/// `applyInventoryOpeningBalance`: the run applied, or applied already by this request.
pub async fn apply(
    conn: &mut PgConnection,
    portal: &impl Portal,
    orders: &impl OrderHistory,
    input: &Application<'_>,
    now: &(dyn Fn() -> DateTime<Utc> + Sync),
) -> Result<Value, String> {
    let request_id = crate::js_number::trim(input.request_id);
    if request_id.is_empty() {
        return Err(thrown("Application request ID is required."));
    }
    if let Some(replay) = find_replay(conn, input, request_id).await? {
        return Ok(replay);
    }
    let unique: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *conn)
        .await
        .map_err(node_pg::thrown)?;
    let revalidation = format!("{request_id}:inventory-revalidation:{unique}");
    let observation = capture::capture(
        conn,
        portal,
        &Capture {
            request_id: &revalidation,
            seller: input.seller,
            purpose: Some(json!({
                "kind": "opening_apply",
                "applicationRequestId": request_id,
                "runId": input.run_id,
                "evidenceFingerprint": input.evidence_fingerprint,
            })),
        },
        now,
    )
    .await?;
    if observation["status"] != "complete" {
        return Err(thrown(
            "Current seller inventory could not be observed consistently.",
        ));
    }
    orders.catch_up(conn, input.seller).await?;
    let validation = observation["id"].as_str().unwrap_or_default();
    applied(conn, input, request_id, validation)
        .await
        .map_err(|error| {
            thrown(&format!(
                "{error} Current inventory evidence is observation {validation}."
            ))
        })
}

/// `findApplicationReplay`: the run when this request already applied it, none when it is
/// still previewed with this fingerprint, and a refusal otherwise.
async fn find_replay(
    conn: &mut PgConnection,
    input: &Application<'_>,
    request_id: &str,
) -> Result<Option<Value>, String> {
    let row = sqlx::query(
        r#"SELECT run.id::text AS id,run.status,
      run.evidence_fingerprint AS "evidenceFingerprint",run.apply_request_id AS "applyRequestId",
      run.validation_observation_id::text AS "validationObservationId",
      validation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
      validation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
      FROM inventory_opening_balance_runs run
      LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
      WHERE run.id=$1::bigint AND run.seller_key=$2"#,
    )
    .bind(input.run_id)
    .bind(crate::js_number::trim(input.seller))
    .fetch_optional(&mut *conn)
    .await
    .map_err(node_pg::thrown)?;
    let Some(row) = row else {
        return Err(thrown("Opening balance preview was not found."));
    };
    let run = node_pg::row(&row)?;
    if run["status"] != "applied" {
        if run["status"] != "previewed" || run["evidenceFingerprint"] != input.evidence_fingerprint
        {
            return Err(thrown("Opening balance preview is blocked or stale."));
        }
        return Ok(None);
    }
    if run["applyRequestId"] != request_id
        || run["evidenceFingerprint"] != input.evidence_fingerprint
    {
        return Err(thrown("Opening balance application evidence conflicts."));
    }
    Ok(Some(run))
}

/// The run as `apply` reads and answers it.
const RUN: &str = r#"SELECT run.id::text AS id,run.seller_key AS "sellerKey",run.cutoff_at AS "cutoffAt",run.status,
          run.evidence_fingerprint AS "evidenceFingerprint",run.observation_id::text AS "observationId",
          run.apply_request_id AS "applyRequestId",
          run.validation_observation_id::text AS "validationObservationId",
          validation.unsupported_positive_item_count AS "unsupportedPositiveItemCount",
          validation.unsupported_positive_quantity AS "unsupportedPositiveQuantity"
         FROM inventory_opening_balance_runs run
         LEFT JOIN inventory_complete_observations validation ON validation.id=run.validation_observation_id
         WHERE run.id=$1::bigint AND run.seller_key=$2 FOR UPDATE OF run"#;

/// The observation that revalidated the run, beside the run's own supported fingerprint.
#[derive(sqlx::FromRow)]
struct Validation {
    id: String,
    seller_key: String,
    status: String,
    started_at: DateTime<Utc>,
    cutoff_at: DateTime<Utc>,
    supported_quantity_fingerprint: String,
    unsupported_positive_item_count: i32,
    unsupported_positive_quantity: i32,
    is_fresh: bool,
    original_supported_quantity_fingerprint: String,
}

/// The order sync that covers the revalidation, as the run records it.
const COVERAGE: &str = r#"SELECT id::text AS id,finished_at AS "finishedAt",
          observed_from AS "observedFrom",observed_through AS "observedThrough",
          orders_observed AS "ordersObserved",details_recorded AS "detailsRecorded"
        FROM seller_order_sync_runs
        WHERE seller_key=$1 AND source='tcgplayer_api' AND status='complete' AND finished_at >= $2
        ORDER BY finished_at ASC LIMIT 1"#;

/// The repository's `apply`, in a transaction of its own: its failure is Node's `String(error)`.
async fn applied(
    conn: &mut PgConnection,
    input: &Application<'_>,
    request_id: &str,
    validation_id: &str,
) -> Result<Value, String> {
    let failed = node_pg::thrown;
    let mut tx = conn.begin().await.map_err(failed)?;
    let seller = crate::js_number::trim(input.seller);
    let row = sqlx::query(RUN)
        .bind(input.run_id)
        .bind(seller)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
    let Some(row) = row else {
        return Err(thrown("Opening balance preview was not found."));
    };
    let mut run = node_pg::row(&row)?;
    let cutoff_at: DateTime<Utc> = sqlx::Row::try_get(&row, "cutoffAt").map_err(failed)?;
    if run["status"] == "applied" {
        if run["evidenceFingerprint"] != input.evidence_fingerprint
            || run["applyRequestId"] != request_id
        {
            return Err(thrown("Opening balance application evidence conflicts."));
        }
        tx.commit().await.map_err(failed)?;
        return Ok(run);
    }
    if run["status"] != "previewed" || run["evidenceFingerprint"] != input.evidence_fingerprint {
        return Err(thrown("Opening balance preview is blocked or stale."));
    }
    let run_seller = run["sellerKey"].as_str().unwrap_or_default().to_owned();
    let observation_id = run["observationId"].as_str().unwrap_or_default().to_owned();
    for lock in [
        format!("opening:{run_seller}"),
        format!("opening-observation:{run_seller}"),
    ] {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(lock)
            .execute(&mut *tx)
            .await
            .map_err(failed)?;
    }
    let validation: Option<Validation> = sqlx::query_as(
        "SELECT validation.id::text AS id,validation.seller_key,validation.status,
          validation.started_at,validation.cutoff_at,
          validation.supported_quantity_fingerprint,
          validation.unsupported_positive_item_count,validation.unsupported_positive_quantity,
          validation.cutoff_at >= NOW()-INTERVAL '5 minutes' AS is_fresh,
          original.supported_quantity_fingerprint AS original_supported_quantity_fingerprint
         FROM inventory_complete_observations validation
         JOIN inventory_complete_observations original ON original.id=$2::bigint
         WHERE validation.id=$1::bigint",
    )
    .bind(validation_id)
    .bind(&observation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let matches = validation.as_ref().is_some_and(|v| {
        v.seller_key == run_seller
            && v.status == "complete"
            && v.supported_quantity_fingerprint == v.original_supported_quantity_fingerprint
            && v.cutoff_at.timestamp_millis() > cutoff_at.timestamp_millis()
            && v.is_fresh
    });
    let (true, Some(validation)) = (matches, validation) else {
        return Err(thrown(
            "Current complete seller inventory does not match the opening preview.",
        ));
    };
    if !preview::observation_items_consistent(&mut tx, &validation.id).await? {
        return Err(thrown(
            "Current inventory item evidence is unavailable or inconsistent.",
        ));
    }
    let latest: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM inventory_complete_observations
        WHERE seller_key=$1 ORDER BY cutoff_at DESC,id DESC LIMIT 1",
    )
    .bind(&run_seller)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if latest.as_deref() != Some(validation.id.as_str()) {
        return Err(thrown(
            "A newer seller inventory observation must be reconciled first.",
        ));
    }
    let unresolved: i32 = sqlx::query_scalar(
        "SELECT COUNT(*)::int
        FROM inventory_observation_differences difference
        JOIN inventory_complete_observations observation ON observation.id=difference.observation_id
        WHERE observation.seller_key=$1 AND observation.cutoff_at>$2 AND observation.cutoff_at<=$3
          AND difference.status='unresolved' AND difference.sku IS NOT NULL",
    )
    .bind(&run_seller)
    .bind(cutoff_at)
    .bind(validation.cutoff_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    if unresolved > 0 {
        return Err(thrown(
            "Current seller inventory differences must be acknowledged before apply.",
        ));
    }
    let coverage = sqlx::query(COVERAGE)
        .bind(&run_seller)
        .bind(validation.cutoff_at)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
    let Some(coverage) = coverage.map(|row| node_pg::row(&row)).transpose()? else {
        return Err(thrown(
            "Complete seller order coverage after inventory revalidation is required.",
        ));
    };
    let interval = |sql: &'static str| sqlx::query_scalar::<_, i32>(sql);
    let interval_orders = interval(
        "SELECT COUNT(*)::int FROM seller_orders
        WHERE seller_key=$1 AND order_time >= $2 AND order_time < $3",
    )
    .bind(&run_seller)
    .bind(validation.started_at)
    .bind(validation.cutoff_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    let interval_publications = interval(
        "SELECT COUNT(*)::int FROM inventory_publication_receipt_links
        WHERE target_seller_key=$1 AND live_at >= $2 AND live_at < $3",
    )
    .bind(&run_seller)
    .bind(validation.started_at)
    .bind(validation.cutoff_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    if interval_orders > 0 || interval_publications > 0 {
        return Err(thrown(
            "Seller inventory changed during apply revalidation.",
        ));
    }
    let source = preview::source_evidence(&mut tx, &run_seller, cutoff_at, &observation_id).await?;
    let coverage_run: Option<String> = sqlx::query_scalar(
        "SELECT order_coverage_run_id::text FROM inventory_opening_balance_runs WHERE id=$1::bigint",
    )
    .bind(input.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    let observed: Option<String> = sqlx::query_scalar(
        "SELECT supported_quantity_fingerprint FROM inventory_complete_observations WHERE id=$1::bigint",
    )
    .bind(&observation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let coverage_run = coverage_run.map_or(Value::Null, Value::from);
    if preview::evidence_fingerprint(observed.as_deref(), Some(&coverage_run), &source)
        != input.evidence_fingerprint
    {
        return Err(thrown(
            "Opening balance evidence changed; create a new preview.",
        ));
    }
    let expected: i32 = sqlx::query_scalar(
        "SELECT COUNT(*)::int FROM inventory_opening_balance_items
        WHERE run_id=$1::bigint AND opening_quantity>0",
    )
    .bind(input.run_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    let mutations = sqlx::query(
        "INSERT INTO inventory_pending_mutations
          (request_id,mutation_type,sku,requested_quantity,product_line_id,set_id,product_id,quantity_delta,resulting_quantity)
        SELECT 'opening:'||$1::text||':'||item.sku::text,'opening',item.sku,item.opening_quantity,
          item.product_line_id,item.set_id,item.product_id,item.opening_quantity,item.opening_quantity
        FROM inventory_opening_balance_items item
        WHERE item.run_id=$1::bigint AND item.opening_quantity>0
          AND item.product_line_id IS NOT NULL AND item.set_id IS NOT NULL AND item.product_id IS NOT NULL",
    )
    .bind(input.run_id)
    .execute(&mut *tx)
    .await
    .map_err(failed)?
    .rows_affected();
    if mutations != expected as u64 {
        return Err(thrown("Opening balance catalog evidence is incomplete."));
    }
    let receipts = sqlx::query(
        "WITH inserted AS (INSERT INTO inventory_receipts
          (request_id,sku,original_quantity,product_line_id,set_id,product_id,seller_key,intake_at,
           market_value,market_observed_at,market_calculated_at,market_provenance,source_evidence,
           receipt_kind,opening_balance_run_id,fifo_precedence)
          SELECT 'opening:'||$1::text||':'||item.sku::text,item.sku,item.opening_quantity,
            item.product_line_id,item.set_id,item.product_id,$2,NULL,NULL,NULL,NULL,
            'opening_balance_unknown',jsonb_build_object('observationId',$3::bigint,'cutoffAt',$4::timestamptz),
            'opening_balance',$1::bigint,0
          FROM inventory_opening_balance_items item
          WHERE item.run_id=$1::bigint AND item.opening_quantity>0
            AND item.product_line_id IS NOT NULL AND item.set_id IS NOT NULL AND item.product_id IS NOT NULL
          RETURNING receipt_id,sku)
        UPDATE inventory_opening_balance_items item SET receipt_id=inserted.receipt_id
        FROM inserted WHERE item.run_id=$1::bigint AND item.sku=inserted.sku",
    )
    .bind(input.run_id)
    .bind(&run_seller)
    .bind(&observation_id)
    .bind(cutoff_at)
    .execute(&mut *tx)
    .await
    .map_err(failed)?
    .rows_affected();
    if receipts != expected as u64 {
        return Err(thrown("Opening balance receipt conservation failed."));
    }
    sqlx::query(
        "UPDATE inventory_opening_balance_runs SET status='applied',apply_request_id=$2,
        validation_observation_id=$3::bigint,validation_order_coverage_evidence=$4::jsonb,applied_at=NOW()
        WHERE id=$1::bigint",
    )
    .bind(input.run_id)
    .bind(request_id)
    .bind(&validation.id)
    .bind(coverage.to_string())
    .execute(&mut *tx)
    .await
    .map_err(failed)?;
    let affected: Vec<(i32, DateTime<Utc>)> = sqlx::query_as(
        r#"WITH affected AS (
          SELECT sku,$2::timestamptz AS "affectedFrom" FROM inventory_opening_balance_items WHERE run_id=$1::bigint
          UNION ALL
          SELECT line.sku_id::bigint::integer,MIN(orders.order_time) FROM seller_orders orders
            JOIN seller_order_lines line ON line.order_id=orders.id
            WHERE orders.seller_key=$3 AND line.sku_id~'^[1-9][0-9]{0,9}$'
              AND line.sku_id::bigint BETWEEN 1 AND 2147483647
            GROUP BY line.sku_id::bigint
          UNION ALL
          SELECT receipt.sku,MIN(link.live_at) FROM inventory_publication_receipt_links link
            JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
            WHERE link.target_seller_key=$3 AND link.live_at IS NOT NULL AND link.live_at>=$2
            GROUP BY receipt.sku
          UNION ALL
          SELECT sku,affected_from FROM inventory_fifo_replay_queue WHERE seller_key=$3
        ) SELECT sku,MIN("affectedFrom") FROM affected GROUP BY sku"#,
    )
    .bind(input.run_id)
    .bind(cutoff_at)
    .bind(&run_seller)
    .fetch_all(&mut *tx)
    .await
    .map_err(failed)?;
    for (sku, from) in affected {
        queue::enqueue(&mut tx, &run_seller, sku, from)
            .await
            .map_err(failed)?;
    }
    tx.commit().await.map_err(failed)?;
    // `{...run}` as read before the update, so its applyRequestId is still the earlier one.
    run["status"] = "applied".into();
    run["validationObservationId"] = validation.id.into();
    run["unsupportedPositiveItemCount"] = validation.unsupported_positive_item_count.into();
    run["unsupportedPositiveQuantity"] = validation.unsupported_positive_quantity.into();
    Ok(run)
}
