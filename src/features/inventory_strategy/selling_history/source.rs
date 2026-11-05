//! The evidence the selling history is built from: listing episodes in the window, their sales
//! and removals from the FIFO allocations, and what is still unsettled. Ported from
//! `inventorySellingHistory.server.ts`, `loadInventorySellingHistory` and the order coverage of
//! `sellerOrderHistory.server.ts`; the SQL is the Node app's.
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use sqlx::types::Json;

use super::*;
use crate::{database::Database, features::inventory_economics::ledger::proceeds::iso};

pub const EPISODE_LIMIT: i64 = 20_000;
pub const OUTCOME_LIMIT: i64 = 40_000;
/// Publications the selling history may complete with their pricing result per page load.
/// The most items one backfill records, as the Node app's page load asked for.
pub const BACKFILL_LIMIT: i64 = 500;

const OBSERVATION_SQL: &str = r##"SELECT cutoff_at AS "cutoffAt"
FROM inventory_complete_observations
WHERE seller_key=$1 AND status='complete'
ORDER BY cutoff_at DESC,id DESC LIMIT 1"##;

const EPISODES_SQL: &str = r##"WITH all_episodes AS (
  SELECT 'receipt:'||receipt.receipt_id::text AS "episodeKey",
    receipt.receipt_id AS "receiptId",receipt.sku,
    COALESCE(item.product_line,catalog.product_line_name,'Unknown') AS "productLine",
    COALESCE(item.product_name,catalog.product_name,'SKU '||receipt.sku::text) AS "productName",
    'confirmed_publication'::text AS kind,link.planned_quantity AS quantity,
    link.live_at AS "listedAt",item.forecast_evidence AS "forecastEvidence",
    item.forecast_evidence_provenance AS "forecastEvidenceProvenance"
  FROM inventory_publication_receipt_links link
  JOIN inventory_receipts receipt ON receipt.receipt_id=link.receipt_id
  JOIN inventory_publication_items item ON item.id=link.publication_item_id
  LEFT JOIN skus catalog ON catalog.sku=receipt.sku
  WHERE link.target_seller_key=$1 AND link.live_at >= $2 AND link.live_at <= $3
  UNION ALL
  SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key,
    receipt.receipt_id,disposition.sku,
    COALESCE(item.product_line,catalog.product_line_name,'Unknown'),
    COALESCE(item.product_name,catalog.product_name,'SKU '||disposition.sku::text),
    'physical_restock',mapping.quantity,NULL,NULL,'unknown'
  FROM inventory_stock_dispositions disposition
  JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
  JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
  LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
  LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
  LEFT JOIN skus catalog ON catalog.sku=receipt.sku
  WHERE disposition.seller_key=$1 AND disposition.available_at >= $2
    AND disposition.available_at <= $3
  UNION ALL
  SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key,
    receipt.receipt_id,correction.sku,
    COALESCE(item.product_line,catalog.product_line_name,'Unknown'),
    COALESCE(item.product_name,catalog.product_name,'SKU '||correction.sku::text),
    'order_quantity_correction',mapping.quantity,NULL,NULL,'unknown'
  FROM inventory_order_quantity_corrections correction
  JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
  JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
  LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
  LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
  LEFT JOIN skus catalog ON catalog.sku=receipt.sku
  WHERE correction.seller_key=$1 AND correction.available_at >= $2
    AND correction.available_at <= $3
), episodes AS (
  SELECT * FROM all_episodes
  WHERE $4::text IS NULL OR "productLine"=$4
)
SELECT "episodeKey","receiptId"::bigint,sku::bigint,"productLine","productName",kind,
  quantity::bigint,"listedAt","forecastEvidence","forecastEvidenceProvenance",COUNT(*) OVER()::bigint
FROM episodes ORDER BY "listedAt" NULLS LAST,"episodeKey"
LIMIT $5"##;

const OUTCOMES_SQL: &str = r##"WITH episode_keys AS (
  SELECT 'receipt:'||link.receipt_id::text AS key
  FROM inventory_publication_receipt_links link
  JOIN inventory_publication_items item ON item.id=link.publication_item_id
  WHERE link.target_seller_key=$1 AND link.live_at >= $2 AND link.live_at <= $3
    AND ($4::text IS NULL OR item.product_line=$4)
  UNION ALL
  SELECT 'restock:'||disposition.id::text||':'||mapping.source_supply_key
  FROM inventory_stock_dispositions disposition
  JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
  JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
  LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
  LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
  LEFT JOIN skus catalog ON catalog.sku=receipt.sku
  WHERE disposition.seller_key=$1 AND disposition.available_at >= $2
    AND disposition.available_at <= $3
    AND ($4::text IS NULL OR COALESCE(item.product_line,catalog.product_line_name,'Unknown')=$4)
  UNION ALL
  SELECT 'quantity-correction:'||correction.id::text||':'||mapping.source_supply_key
  FROM inventory_order_quantity_corrections correction
  JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
  JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
  LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
  LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
  LEFT JOIN skus catalog ON catalog.sku=receipt.sku
  WHERE correction.seller_key=$1 AND correction.available_at >= $2
    AND correction.available_at <= $3
    AND ($4::text IS NULL OR COALESCE(item.product_line,catalog.product_line_name,'Unknown')=$4)
), outcomes AS (
  SELECT allocation.supply_key AS "episodeKey",
    CASE WHEN orders.lifecycle='canceled' THEN 'removed' ELSE 'sale' END::text AS kind,
    allocation.allocated_quantity AS quantity,orders.order_time AS "happenedAt",
    orders.order_number AS "orderNumber",line.id::text AS "orderLineId",
    CASE WHEN orders.lifecycle='canceled' THEN 'cancellation' ELSE 'seller_order' END::text AS source
  FROM inventory_fifo_lines line
  JOIN seller_orders orders ON orders.id=line.order_id
  JOIN inventory_fifo_revision_allocations allocation
    ON allocation.revision_id=line.current_revision_id
  JOIN episode_keys episode ON episode.key=allocation.supply_key
  LEFT JOIN inventory_fifo_replay_queue replay
    ON replay.seller_key=line.seller_key AND replay.sku=line.sku
  WHERE line.seller_key=$1 AND replay.seller_key IS NULL
    AND orders.order_time >= $2 AND orders.order_time <= $3
    AND line.state IN ('allocated','partial','unmatched')
    AND orders.lifecycle IN ('processing','ready_to_ship','shipped_in_transit',
      'shipped_delivered','completed_paid','canceled')
  UNION ALL
  SELECT mapping.source_supply_key,'removed',mapping.quantity,correction.available_at,
    orders.order_number,line.id::text,'quantity_correction'
  FROM inventory_order_quantity_corrections correction
  JOIN inventory_order_quantity_correction_allocations mapping
    ON mapping.correction_id=correction.id
  JOIN episode_keys episode ON episode.key=mapping.source_supply_key
  JOIN seller_orders orders ON orders.id=correction.order_id
  LEFT JOIN inventory_fifo_lines line ON line.order_id=correction.order_id
    AND line.order_line_sku_id=correction.order_line_sku_id
  WHERE correction.seller_key=$1 AND correction.available_at >= $2
    AND correction.available_at <= $3
)
SELECT "episodeKey",kind,quantity::bigint,"happenedAt","orderNumber","orderLineId",source,
  COUNT(*) OVER()::bigint
FROM outcomes ORDER BY "happenedAt","episodeKey" LIMIT $5"##;

const PRODUCT_LINES_SQL: &str = r##"SELECT DISTINCT item.product_line AS "productLine"
FROM inventory_publication_receipt_links link
JOIN inventory_publication_items item ON item.id=link.publication_item_id
WHERE link.target_seller_key=$1 AND link.live_at IS NOT NULL
  AND link.live_at >= $2 AND link.live_at <= $3
ORDER BY item.product_line LIMIT 100"##;

const PROJECTION_SQL: &str = r##"SELECT
  COALESCE(SUM(line.ordered_quantity) FILTER (
    WHERE replay.status IN ('pending','processing') OR
      (replay.status IS NULL AND line.state='pending')),0)::int AS "pendingQuantity",
  COALESCE(SUM(line.ordered_quantity) FILTER (
    WHERE replay.status='held' OR
      (replay.status IS NULL AND line.state='held')),0)::int AS "heldQuantity"
  ,COALESCE(array_agg(DISTINCT line.sku) FILTER (
    WHERE line.sku IS NOT NULL AND (replay.seller_key IS NOT NULL OR
      line.state IN ('pending','held'))),'{}') AS "affectedSkus",
  (SELECT COALESCE(SUM(COALESCE(coverage.unknown_quantity,receipt.original_quantity)),0)::int
    FROM inventory_receipts receipt
    JOIN inventory_opening_balance_runs opening
      ON opening.id=receipt.opening_balance_run_id AND opening.status='applied'
    LEFT JOIN inventory_listing_history_coverage coverage
      ON coverage.opening_receipt_id=receipt.receipt_id
    LEFT JOIN skus opening_catalog ON opening_catalog.sku=receipt.sku
    WHERE receipt.seller_key=$1 AND receipt.receipt_kind='opening_balance'
      AND ($4::text IS NULL OR COALESCE(opening_catalog.product_line_name,'Unknown')=$4)) AS "openingUnknownQuantity"
  ,(SELECT COALESCE(SUM(item.quantity_delta),0)::int
    FROM inventory_publication_items item
    JOIN inventory_publications publication ON publication.id=item.publication_id
    WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
      AND ($4::text IS NULL OR item.product_line=$4)
      AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
        WHERE link.publication_item_id=item.id)) AS "legacyUnlinkedQuantity"
  ,(SELECT COALESCE(SUM(item.quantity_delta),0)::int
    FROM inventory_publication_items item
    JOIN inventory_publications publication ON publication.id=item.publication_id
    WHERE publication.seller_key=$1 AND item.status='published' AND item.quantity_delta>0
      AND ($4::text IS NULL OR item.product_line=$4)
      AND item.forecast_evidence IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM inventory_publication_receipt_links link
        WHERE link.publication_item_id=item.id)) AS "legacyUnlinkedForecastQuantity",
  (SELECT COALESCE(SUM(link.planned_quantity),0)::int
    FROM inventory_publication_receipt_links link
    JOIN inventory_publication_items item ON item.id=link.publication_item_id
    WHERE link.target_seller_key=$1 AND link.live_at<$2
      AND ($4::text IS NULL OR item.product_line=$4)) AS "olderPublicationQuantity",
  (SELECT COALESCE(SUM(awaiting.quantity),0)::int FROM (
    SELECT link.planned_quantity AS quantity,item.product_line AS "productLine"
    FROM inventory_publication_receipt_links link
    JOIN inventory_publication_items item ON item.id=link.publication_item_id
    WHERE link.target_seller_key=$1 AND link.live_at>$3
    UNION ALL
    SELECT mapping.quantity,COALESCE(item.product_line,catalog.product_line_name,'Unknown')
    FROM inventory_stock_dispositions disposition
    JOIN inventory_stock_disposition_receipts mapping ON mapping.disposition_id=disposition.id
    JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
    LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
    LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
    LEFT JOIN skus catalog ON catalog.sku=receipt.sku
    WHERE disposition.seller_key=$1 AND disposition.available_at>$3
    UNION ALL
    SELECT mapping.quantity,COALESCE(item.product_line,catalog.product_line_name,'Unknown')
    FROM inventory_order_quantity_corrections correction
    JOIN inventory_order_quantity_correction_allocations mapping ON mapping.correction_id=correction.id
    JOIN inventory_receipts receipt ON receipt.receipt_id=mapping.receipt_id
    LEFT JOIN inventory_publication_receipt_links link ON link.receipt_id=receipt.receipt_id
    LEFT JOIN inventory_publication_items item ON item.id=link.publication_item_id
    LEFT JOIN skus catalog ON catalog.sku=receipt.sku
    WHERE correction.seller_key=$1 AND correction.available_at>$3
  ) awaiting WHERE $4::text IS NULL OR awaiting."productLine"=$4) AS "awaitingCutoffQuantity"
FROM inventory_fifo_lines line
LEFT JOIN inventory_fifo_replay_queue replay
  ON replay.seller_key=line.seller_key AND replay.sku=line.sku
LEFT JOIN skus line_catalog ON line_catalog.sku=line.sku
WHERE line.seller_key=$1
  AND ($4::text IS NULL OR COALESCE(line_catalog.product_line_name,'Unknown')=$4)"##;

const UNRESOLVED_REMOVAL_SQL: &str = r##"WITH held AS (
  SELECT replay.sku,
    substring(replay.hold_reason FROM 'observed_(-?[0-9]+)')::int AS observed,
    substring(replay.hold_reason FROM 'expected_(-?[0-9]+)')::int AS expected
  FROM inventory_fifo_replay_queue replay
  LEFT JOIN skus catalog ON catalog.sku=replay.sku
  WHERE replay.seller_key=$1 AND replay.status='held'
    AND replay.hold_reason ~ '^unexplained_inventory_difference:[0-9]+:observed_-?[0-9]+:expected_-?[0-9]+$'
    AND ($2::text IS NULL OR COALESCE(catalog.product_line_name,'Unknown')=$2)
), removals AS (
  SELECT sku,GREATEST(expected-observed,0)::int AS quantity FROM held
)
SELECT COALESCE(SUM(quantity),0)::bigint AS quantity,
  COALESCE(array_agg(DISTINCT sku) FILTER (WHERE quantity>0),'{}') AS "affectedSkus"
FROM removals"##;

type EpisodeRow = (
    String,
    i64,
    i64,
    String,
    String,
    String,
    i64,
    Option<DateTime<Utc>>,
    Option<Json<Value>>,
    String,
    i64,
);

type OutcomeRow = (
    String,
    String,
    i64,
    DateTime<Utc>,
    Option<String>,
    Option<String>,
    String,
    i64,
);

/// Postgres sums to int here, as the Node app reads them.
type ProjectionRow = (i32, i32, Vec<i32>, i32, i32, i32, i32, i32);

fn parse<T: serde::de::DeserializeOwned>(value: &str) -> sqlx::Result<T> {
    serde_json::from_value(Value::String(value.to_string()))
        .map_err(|e| sqlx::Error::Decode(Box::new(e)))
}

fn episode(row: EpisodeRow) -> sqlx::Result<Episode> {
    let (
        episode_key,
        receipt_id,
        sku,
        product_line,
        product_name,
        kind,
        quantity,
        listed_at,
        evidence,
        provenance,
        _,
    ) = row;
    Ok(Episode {
        episode_key,
        receipt_id,
        sku,
        product_line,
        product_name,
        kind: parse(&kind)?,
        quantity,
        listed_at: listed_at.map(iso),
        forecast_evidence: evidence.map(|Json(value)| value),
        forecast_evidence_provenance: parse(&provenance)?,
    })
}

fn outcome(row: OutcomeRow) -> sqlx::Result<Outcome> {
    let (episode_key, kind, quantity, happened_at, order_number, order_line_id, source, _) = row;
    Ok(Outcome {
        episode_key,
        kind: parse(&kind)?,
        quantity,
        happened_at: iso(happened_at),
        order_number,
        order_line_id,
        source: parse(&source)?,
    })
}

type RunRow = (
    String,
    String,
    String,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<i32>,
    Option<i32>,
    i32,
    i32,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<Json<Value>>,
    Option<String>,
    DateTime<Utc>,
);

/// The latest order sync from TCGplayer for the seller, as `getCoverage` reads it.
pub async fn order_coverage(db: &Database, seller: &str) -> sqlx::Result<OrderCoverage> {
    let row: Option<RunRow> = sqlx::query_as(
        "SELECT seller_key, source, status, search_range, finished_at, next_offset, expected_total,
           orders_observed, details_recorded, observed_from, observed_through, gaps, error, updated_at
         FROM seller_order_sync_runs WHERE seller_key=$1 AND source='tcgplayer_api'
         ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .bind(seller)
    .fetch_optional(&db.0)
    .await?;
    let Some((
        seller_key,
        source,
        status,
        search_range,
        finished_at,
        next_offset,
        expected_total,
        orders_observed,
        details_recorded,
        observed_from,
        observed_through,
        gaps,
        error,
        updated_at,
    )) = row
    else {
        return Ok(OrderCoverage::not_started(seller));
    };
    let gaps = gaps
        .and_then(|Json(gaps)| gaps.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|gap| gap["orderNumber"].as_str().unwrap_or_default().to_string())
        .collect();
    Ok(OrderCoverage {
        seller_key,
        source,
        status,
        search_range: search_range.filter(|range| !range.is_empty()),
        observed_from: observed_from.map(iso),
        observed_through: observed_through.map(iso),
        last_attempt_at: Some(iso(updated_at)),
        completed_at: finished_at.map(iso),
        expected_total: expected_total.map(i64::from),
        orders_observed: i64::from(orders_observed),
        details_recorded: i64::from(details_recorded),
        next_offset: next_offset.map(i64::from),
        gaps,
        error: error.filter(|e| !e.is_empty()),
    })
}

/// Everything the report for the scope is built from, as of the last complete order sync.
pub async fn find_evidence(
    db: &Database,
    seller: &str,
    scope: &Scope,
) -> sqlx::Result<SourceEvidence> {
    let (order_coverage, observation) = tokio::try_join!(
        order_coverage(db, seller),
        sqlx::query_as::<_, (DateTime<Utc>,)>(OBSERVATION_SQL)
            .bind(seller)
            .fetch_optional(&db.0),
    )?;
    let as_of = order_coverage
        .completed_at
        .as_deref()
        .and_then(|at| at.parse::<DateTime<Utc>>().ok())
        .unwrap_or_else(Utc::now);
    let analysis_from = as_of - Duration::days(scope.window_days);
    let line = scope.product_line.as_deref();
    let (episodes, outcomes, product_lines, projection, removal) = tokio::try_join!(
        sqlx::query_as::<_, EpisodeRow>(EPISODES_SQL)
            .bind(seller)
            .bind(analysis_from)
            .bind(as_of)
            .bind(line)
            .bind(EPISODE_LIMIT)
            .fetch_all(&db.0),
        sqlx::query_as::<_, OutcomeRow>(OUTCOMES_SQL)
            .bind(seller)
            .bind(analysis_from)
            .bind(as_of)
            .bind(line)
            .bind(OUTCOME_LIMIT)
            .fetch_all(&db.0),
        sqlx::query_as::<_, (String,)>(PRODUCT_LINES_SQL)
            .bind(seller)
            .bind(as_of - Duration::days(730))
            .bind(as_of)
            .fetch_all(&db.0),
        sqlx::query_as::<_, ProjectionRow>(PROJECTION_SQL)
            .bind(seller)
            .bind(analysis_from)
            .bind(as_of)
            .bind(line)
            .fetch_optional(&db.0),
        sqlx::query_as::<_, (i64, Vec<i32>)>(UNRESOLVED_REMOVAL_SQL)
            .bind(seller)
            .bind(line)
            .fetch_optional(&db.0),
    )?;
    let episode_count = episodes.first().map_or(0, |row| row.10);
    let outcome_count = outcomes.first().map_or(0, |row| row.7);
    let (pending, held, affected, opening_unknown, legacy, legacy_forecast, older, awaiting) =
        projection.unwrap_or((0, 0, Vec::new(), 0, 0, 0, 0, 0));
    let (removal_quantity, removal_skus) = removal.unwrap_or_default();
    Ok(SourceEvidence {
        seller_key: seller.to_string(),
        scope: scope.clone(),
        available_product_lines: product_lines.into_iter().map(|(line,)| line).collect(),
        analysis_from: iso(analysis_from),
        inventory_observed_at: observation.map(|(at,)| iso(at)),
        order_coverage,
        episodes: episodes
            .into_iter()
            .map(episode)
            .collect::<sqlx::Result<_>>()?,
        episode_count,
        outcomes: outcomes
            .into_iter()
            .map(outcome)
            .collect::<sqlx::Result<_>>()?,
        outcome_count,
        projection: Projection {
            pending_quantity: i64::from(pending),
            held_quantity: i64::from(held),
            affected_skus: affected.into_iter().map(i64::from).collect(),
        },
        opening_unknown_quantity: i64::from(opening_unknown),
        legacy_unlinked: LegacyUnlinked {
            quantity: i64::from(legacy),
            forecast_quantity: i64::from(legacy_forecast),
        },
        older_publication_quantity: i64::from(older),
        awaiting_cutoff_quantity: i64::from(awaiting),
        unresolved_removal: UnresolvedRemoval {
            quantity: removal_quantity,
            affected_skus: removal_skus.into_iter().map(i64::from).collect(),
        },
    })
}

/// Records the forecast a published item was priced with, from its exact pricing result, on up to
/// `limit` items that lack it: `backfillSupportedForecastEvidence`. Returns how many it recorded.
pub async fn backfill_supported_forecast_evidence(
    db: &Database,
    seller: &str,
    limit: i64,
) -> Result<u64, String> {
    let seller = seller.trim();
    if seller.is_empty() {
        return Err("Seller key is required for forecast evidence backfill.".into());
    }
    if !(1..=1_000).contains(&limit) {
        return Err("Forecast evidence backfill limit must be between 1 and 1000.".into());
    }
    let done = sqlx::query(BACKFILL_SQL)
        .bind(seller)
        .bind(limit)
        .execute(&db.0)
        .await
        .map_err(|e| e.to_string())?;
    Ok(done.rows_affected())
}

const BACKFILL_SQL: &str = r##"WITH supported AS (
  SELECT item.id,result.pricing_details_json
  FROM inventory_publication_items item
  JOIN inventory_publications publication ON publication.id=item.publication_id
  JOIN inventory_batch_results result
    ON result.batch_number=item.batch_number AND result.sku=item.sku
    AND result.priced_at=item.priced_at
  WHERE publication.seller_key=$1
    AND item.forecast_evidence IS NULL AND item.status='published'
    AND item.quantity_delta>0
    AND result.result_status='successful'
    AND result.pricing_details_json IS NOT NULL
    AND item.candidate_key='pricing-result:'||result.batch_number::text||':'||
      result.sku::text||':'||to_char(result.priced_at AT TIME ZONE 'UTC',
'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND jsonb_typeof(result.pricing_details_json->'schemaVersion')='number'
    AND result.pricing_details_json->>'pricedAt'=to_char(
      result.priced_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    AND result.pricing_details_json->>'marketplacePrice' ~ '^[0-9]+(.[0-9]+)?$'
    AND (result.pricing_details_json->>'marketplacePrice')::numeric(12,2)=item.desired_price
  ORDER BY item.id LIMIT $2
)
UPDATE inventory_publication_items item SET
  forecast_evidence=jsonb_strip_nulls(jsonb_build_object(
    'source','historical_pricing_result_exact_match',
    'schemaVersion',supported.pricing_details_json->'schemaVersion',
    'pricingModelVersion',supported.pricing_details_json->'pricingModelVersion',
    'pricedAt',supported.pricing_details_json->'pricedAt',
    'policy',supported.pricing_details_json->'policy',
    'decision',supported.pricing_details_json->'decision',
    'buyerChoiceForecast',supported.pricing_details_json->'buyerChoiceForecast',
    'conditionRateForecast',supported.pricing_details_json->'conditionRateForecast',
    'estimatedTimeToSellDays',supported.pricing_details_json->'estimatedTimeToSellDays')),
  forecast_evidence_provenance='recorded',updated_at=NOW()
FROM supported WHERE item.id=supported.id RETURNING item.id"##;

/// The report for one page of details. Only reads: the forecast evidence the details show is
/// completed by the backfill task (`super::super::backfill`), where the Node app completed it on
/// every load.
pub async fn load(
    db: &Database,
    seller: &str,
    scope: &Scope,
    detail_page: usize,
) -> Result<Report, String> {
    let seller = seller.trim();
    if seller.is_empty() {
        return Ok(Report::Unavailable(Box::new(Unavailable {
            seller_key: String::new(),
            scope: scope.clone(),
            available_product_lines: Vec::new(),
            reason: UnavailableReason::SellerNotConfigured,
            order_coverage: OrderCoverage::not_started(""),
        })));
    }
    let evidence = find_evidence(db, seller, scope)
        .await
        .map_err(|e| e.to_string())?;
    build(&evidence, detail_page)
}
