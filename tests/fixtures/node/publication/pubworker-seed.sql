-- The publication worker's world for its recorded turns
-- (scripts/parity/pubworker.ts and inventory_publication::worker's turns_run_as_node_runs_them):
-- nothing else in flight, publications going to the seller "pubworker", a received batch copied
-- from dev batch 2730 (priced an hour ago, with receipts of its own) and that seller's live
-- inventory copied from the dev seller. Ids are fixed and far past dev's.
UPDATE inventory_publications SET status = 'failed'
  WHERE status IN ('planned', 'staging', 'staged', 'publishing', 'ambiguous');
UPDATE inventory_intake_runs SET planning_status = 'needs_review' WHERE planning_status = 'waiting';
UPDATE inventory_publication_settings
  SET settings_json = '{"policy":{"allowWarnings":false,"automaticSources":{"csv":false,"seller":false,"continuous":true,"pending_inventory":true},"stagedFlushWindowMs":60000,"maximumCandidateAgeMs":86400000,"stagedMicroBatchMaximum":250,"automaticPublishingEnabled":true,"minimumAbsolutePriceChange":0.01,"minimumRelativePriceChangePercent":0},"globalPaused":false,"continuousPricing":{"enabled":true,"batchSize":50,"sellerKey":"pubworker","schedulerPollSeconds":30,"minimumIntervalMinutes":1440,"inventoryRefreshMinutes":60},"consecutiveFailureLimit":3}'::jsonb,
      authentication_status = 'healthy', circuit_open = false, consecutive_failures = 0,
      pause_reason = NULL, last_success_at = NULL, last_failure_at = NULL
  WHERE config_key = 'default';

INSERT INTO inventory_batches (batch_number, status, created_at, updated_at, last_priced_at,
    last_percentile_used, summary_json, successful_count, manual_review_count, source_type,
    source_label, source_request_id)
  OVERRIDING SYSTEM VALUE
  SELECT 990001, status, now() - interval '3 hours', now() - interval '1 hour', now() - interval '1 hour',
    last_percentile_used, summary_json, successful_count, manual_review_count, source_type,
    source_label, 'pubworker-990001'
  FROM inventory_batches WHERE batch_number = 2730;
INSERT INTO inventory_batch_items (batch_number, sku, add_to_quantity, product_line_id, set_id,
    product_id, created_at, updated_at, total_quantity, current_price, original_row_json)
  SELECT 990001, sku, add_to_quantity, product_line_id, set_id, product_id,
    now() - interval '3 hours', now() - interval '3 hours', total_quantity, current_price, original_row_json
  FROM inventory_batch_items WHERE batch_number = 2730;
INSERT INTO inventory_batch_pricing_jobs (id, batch_number, mode, status, config_json, progress_json,
    summary_json, attempt_count, started_at, completed_at, created_at, updated_at, priority)
  OVERRIDING SYSTEM VALUE
  SELECT 990000001, 990001, mode, 'completed', config_json, progress_json, summary_json, 1,
    now() - interval '2 hours', now() - interval '1 hour', now() - interval '3 hours', now() - interval '1 hour', priority
  FROM inventory_batch_pricing_jobs WHERE id = 2735;
INSERT INTO inventory_batch_results (batch_number, sku, result_status, row_json, error_messages,
    warning_messages, priced_at, pricing_details_json)
  SELECT 990001, sku, result_status, row_json, error_messages, warning_messages,
    now() - interval '1 hour', pricing_details_json
  FROM inventory_batch_results WHERE batch_number = 2730;
INSERT INTO inventory_batch_intake_requests (request_id, batch_number, recorded_at)
  VALUES ('pubworker-990001', 990001, now() - interval '3 hours');

INSERT INTO inventory_pending_mutations (request_id, mutation_type, sku, requested_quantity,
    product_line_id, set_id, product_id, quantity_delta, resulting_quantity, recorded_at)
  SELECT 'pubworker-receipt-' || sku, 'add', sku, add_to_quantity, product_line_id, set_id,
    product_id, add_to_quantity, add_to_quantity, now() - interval '3 hours'
  FROM inventory_batch_items WHERE batch_number = 990001 AND add_to_quantity > 0;
INSERT INTO inventory_receipts (receipt_id, request_id, sku, original_quantity, product_line_id,
    set_id, product_id, seller_key, intake_at, recorded_at, market_value, market_provenance,
    source_evidence, receipt_kind, fifo_precedence)
  OVERRIDING SYSTEM VALUE
  SELECT 990000000 + row_number() OVER (ORDER BY sku), 'pubworker-receipt-' || sku, sku,
    add_to_quantity, product_line_id, set_id, product_id, NULL, now() - interval '3 hours',
    now() - interval '3 hours', current_price, 'tcgplayer_price_points',
    '{"source": "inventory_manager"}', 'received', 1
  FROM inventory_batch_items WHERE batch_number = 990001 AND add_to_quantity > 0;
INSERT INTO inventory_receipt_batch_links (receipt_id, batch_number, linked_quantity, linked_at)
  SELECT receipt_id, 990001, original_quantity, now() - interval '3 hours'
  FROM inventory_receipts WHERE receipt_id > 990000000;

INSERT INTO continuous_pricing_inventory (seller_key, sku, product_id, product_line_id, set_id,
    product_line, set_name, product_name, condition, variant, quantity, current_price, in_stock,
    enabled, pause_reason, last_observed_at, last_priced_at, last_published_price,
    last_published_at, next_price_at, last_batch_number, consecutive_pricing_failures,
    created_at, updated_at, market_price, pricing_eligible)
  SELECT 'pubworker', sku, product_id, product_line_id, set_id, product_line, set_name,
    product_name, condition, variant, quantity, current_price, in_stock, true, NULL,
    now() - interval '2 hours', now() - interval '2 days', current_price, now() - interval '2 days',
    now() - interval '1 hour', NULL, 0, now() - interval '30 days', now() - interval '2 hours',
    market_price, pricing_eligible
  FROM continuous_pricing_inventory
  WHERE seller_key = '8520a14f'
    AND (sku IN (SELECT sku FROM inventory_batch_items WHERE batch_number = 2730)
      OR sku IN (446147, 446597, 447529, 447569, 447673, 447950, 448163, 448279, 448306, 448635, 448708, 448817));

-- A publication of the seller's live SKUs, priced fifty cents above their price an hour ago.
CREATE FUNCTION pg_temp.pubworker_publication(key text, publishing text, skus int[])
RETURNS bigint LANGUAGE sql AS $$
  WITH publication AS (
    INSERT INTO inventory_publications (planning_key, method, source_type, seller_key, config_json)
    VALUES (key, publishing, 'continuous', 'pubworker', '{}') RETURNING id
  ), items AS (
    INSERT INTO inventory_publication_items (publication_id, candidate_key, sku, product_id,
        product_line, set_name, product_name, condition, previous_price, desired_price, priced_at)
    SELECT publication.id, key || ':' || c.sku, c.sku, c.product_id, c.product_line, c.set_name,
      c.product_name, c.condition, c.current_price, c.current_price + 0.5, now() - interval '1 hour'
    FROM publication, continuous_pricing_inventory c
    WHERE c.seller_key = 'pubworker' AND c.sku = ANY(skus)
    RETURNING 1
  )
  SELECT id FROM publication WHERE (SELECT count(*) FROM items) >= 0
$$;
