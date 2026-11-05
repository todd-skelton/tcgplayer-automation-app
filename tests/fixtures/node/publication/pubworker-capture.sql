-- What a case of the publication worker's recorded turns wrote, for scripts/parity/pubworker.ts and
-- inventory_publication::worker's turns_run_as_node_runs_them. Ids and clock times differ between
-- runs, so publications are named by planning key, items by SKU, and times by whether they are set
-- or how they relate. Prices are read as float8, so 4.00 is the number 4 on both sides.
WITH publication AS (
  SELECT * FROM inventory_publications WHERE seller_key = 'pubworker' OR batch_number = 990001
), item AS (
  SELECT i.*, p.planning_key FROM inventory_publication_items i JOIN publication p ON p.id = i.publication_id
)
SELECT json_build_object(
  'publications', (SELECT coalesce(json_agg(json_build_object(
      'key', planning_key, 'batch', batch_number, 'job', pricing_job_id, 'method', method,
      'source', source_type, 'seller', seller_key, 'status', status, 'upload', staged_pricing_upload_id,
      'config', config_json, 'progress', progress_json, 'errorCode', error_code, 'errorMessage', error_message,
      'attempts', attempt_count, 'claimedBy', claimed_by, 'leased', claim_expires_at IS NOT NULL,
      'staged', staged_at IS NOT NULL, 'publishing', publishing_at IS NOT NULL,
      'published', published_at IS NOT NULL, 'completed', completed_at IS NOT NULL,
      'publishedWithItems', published_at = (SELECT max(published_at) FROM item WHERE item.publication_id = publication.id))
    ORDER BY planning_key), '[]') FROM publication),
  'items', (SELECT coalesce(json_agg(json_build_object(
      'key', planning_key, 'sku', sku, 'batch', batch_number, 'productId', product_id, 'condition', condition,
      'previousPrice', previous_price::float8, 'desiredPrice', desired_price::float8, 'quantityDelta', quantity_delta,
      'deltaKey', inventory_delta_key IS NOT NULL, 'observedQuantity', observed_quantity,
      'absoluteQuantity', desired_absolute_quantity, 'reasons', eligibility_reasons, 'status', status,
      'errorCode', error_code, 'errorMessage', error_message, 'published', published_at IS NOT NULL,
      'provenance', forecast_evidence_provenance)
    ORDER BY planning_key, sku), '[]') FROM item),
  'links', (SELECT coalesce(json_agg(json_build_object(
      'key', item.planning_key, 'sku', item.sku, 'receipt', link.receipt_id, 'planned', link.planned_quantity,
      'seller', link.target_seller_key, 'liveWithItem', link.live_at = item.published_at,
      'live', link.live_at IS NOT NULL, 'activated', link.activated_at IS NOT NULL,
      'evidence', link.confirmation_evidence)
    ORDER BY item.planning_key, item.sku, link.receipt_id), '[]')
    FROM inventory_publication_receipt_links link JOIN item ON item.id = link.publication_item_id),
  'receipts', (SELECT coalesce(json_agg(json_build_object('receipt', receipt_id, 'sku', sku, 'seller', seller_key)
    ORDER BY receipt_id), '[]') FROM inventory_receipts WHERE receipt_id > 990000000),
  'settings', (SELECT json_build_object('paused', settings_json -> 'globalPaused',
      'authentication', authentication_status, 'circuitOpen', circuit_open,
      'failures', consecutive_failures, 'pauseReason', pause_reason,
      'succeeded', last_success_at IS NOT NULL, 'failed', last_failure_at IS NOT NULL)
    FROM inventory_publication_settings WHERE config_key = 'default'),
  'inventory', (SELECT coalesce(json_agg(json_build_object(
      'sku', sku, 'currentPrice', current_price::float8, 'lastPublishedPrice', last_published_price::float8,
      'republished', last_published_at > now() - interval '1 day',
      'priced', last_priced_at > now() - interval '1 day',
      'heldForInterval', next_price_at >= last_published_at + interval '1440 minutes',
      'pauseReason', pause_reason)
    ORDER BY sku), '[]') FROM continuous_pricing_inventory WHERE seller_key = 'pubworker'),
  'curves', (SELECT coalesce(json_agg(json_build_object('sku', curve.sku, 'batch', curve.batch_number,
      'pricedWithResult', curve.priced_at = result.priced_at,
      'details', curve.pricing_details_json = result.pricing_details_json)
    ORDER BY curve.sku), '[]')
    FROM inventory_strategy_pricing_curves curve
    LEFT JOIN inventory_batch_results result ON result.batch_number = curve.batch_number AND result.sku = curve.sku
    WHERE curve.seller_key = 'pubworker'),
  'fifo', (SELECT coalesce(json_agg(json_build_object('sku', queue.sku, 'status', queue.status,
      'generation', queue.generation,
      'fromLive', queue.affected_from = (SELECT max(published_at) FROM item WHERE item.sku = queue.sku)
    ) ORDER BY queue.sku), '[]')
    FROM inventory_fifo_replay_queue queue WHERE queue.seller_key = 'pubworker'),
  'intake', (SELECT coalesce(json_agg(json_build_object('status', planning_status, 'error', planning_error,
      'attempts', planning_attempts, 'retryLater', next_attempt_at > now())), '[]')
    FROM inventory_intake_runs WHERE batch_number = 990001)
)::text
