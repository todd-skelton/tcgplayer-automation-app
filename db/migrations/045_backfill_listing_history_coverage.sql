-- Listing history coverage: units the application published before the applied
-- opening-balance cutoff carry their own listing time and the TCG market price
-- from the exact pricing result that priced them. Backfilling those
-- publications as receipt lots lets FIFO measure days listed and market at
-- listing for sales before and after the cutoff instead of treating every
-- opening unit as unknown.
--
-- For each seller/SKU with pre-cutoff positive publications the ledger is:
--   unknown = opening + ordered(covered_from..cutoff) - published(covered_from..cutoff)
-- Units that predate the first covered publication are unknown-origin supply
-- available at covered_from and are sold first. A SKU whose evidence cannot
-- balance (unknown < 0) is left untouched and remains legacy.
CREATE TABLE IF NOT EXISTS inventory_listing_history_coverage (
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  sku INTEGER NOT NULL CHECK (sku > 0),
  opening_balance_run_id BIGINT NOT NULL
    REFERENCES inventory_opening_balance_runs(id) ON DELETE RESTRICT,
  covered_from TIMESTAMPTZ NOT NULL,
  published_quantity INTEGER NOT NULL CHECK (published_quantity > 0),
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity >= 0),
  opening_quantity INTEGER NOT NULL CHECK (opening_quantity >= 0),
  unknown_quantity INTEGER NOT NULL CHECK (unknown_quantity >= 0),
  opening_receipt_id INTEGER
    REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seller_key, sku),
  UNIQUE (opening_receipt_id),
  CHECK (unknown_quantity = opening_quantity + ordered_quantity - published_quantity),
  CHECK (unknown_quantity = 0 OR opening_receipt_id IS NOT NULL)
);

CREATE OR REPLACE FUNCTION preserve_inventory_listing_history_coverage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Inventory listing history coverage is immutable';
END;
$$;

DROP TRIGGER IF EXISTS inventory_listing_history_coverage_is_immutable
  ON inventory_listing_history_coverage;
CREATE TRIGGER inventory_listing_history_coverage_is_immutable
BEFORE UPDATE OR DELETE ON inventory_listing_history_coverage
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_listing_history_coverage();

-- Every confirmed positive publication before the cutoff that has no receipt
-- link yet. Publications saved before seller ownership was recorded belong to
-- the only seller with an applied opening balance; with more than one such
-- seller they stay unattributed.
DROP TABLE IF EXISTS pg_temp.listing_history_publications;
CREATE TEMP TABLE listing_history_publications AS
WITH applied AS (
  SELECT run.id AS run_id, run.seller_key, run.cutoff_at,
    (SELECT COUNT(*) FROM inventory_opening_balance_runs WHERE status = 'applied') = 1
      AS only_applied_seller
  FROM inventory_opening_balance_runs run
  WHERE run.status = 'applied'
)
SELECT
  applied.run_id,
  applied.seller_key,
  applied.cutoff_at,
  item.id AS publication_item_id,
  item.sku,
  item.batch_number,
  item.quantity_delta,
  item.published_at,
  item.candidate_key,
  CASE WHEN publication.seller_key IS NULL
    THEN 'only_applied_opening_balance_seller' ELSE 'publication' END AS seller_attribution,
  COALESCE(batch_item.product_line_id, catalog.product_line_id) AS product_line_id,
  COALESCE(batch_item.set_id, catalog.set_id) AS set_id,
  COALESCE(batch_item.product_id, catalog.product_id) AS product_id,
  result.priced_at AS result_priced_at,
  CASE WHEN result.pricing_details_json->>'tcgMarketPrice' ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (result.pricing_details_json->>'tcgMarketPrice')::numeric(12, 4)
    WHEN result.row_json->>'TCG Market Price' ~ '^[0-9]+(\.[0-9]+)?$'
    THEN (result.row_json->>'TCG Market Price')::numeric(12, 4)
    ELSE NULL END AS market_value,
  CASE WHEN result.pricing_details_json->>'marketDataAt' ~ '^\d{4}-\d{2}-\d{2}T'
    THEN (result.pricing_details_json->>'marketDataAt')::timestamptz
    ELSE NULL END AS market_calculated_at
FROM applied
JOIN inventory_publications publication
  ON publication.seller_key = applied.seller_key
  OR (publication.seller_key IS NULL AND applied.only_applied_seller)
JOIN inventory_publication_items item ON item.publication_id = publication.id
LEFT JOIN inventory_batch_items batch_item
  ON batch_item.batch_number = item.batch_number AND batch_item.sku = item.sku
LEFT JOIN skus catalog ON catalog.sku = item.sku
LEFT JOIN inventory_batch_results result
  ON result.batch_number = item.batch_number AND result.sku = item.sku
  AND result.result_status = 'successful' AND result.priced_at = item.priced_at
WHERE item.status = 'published'
  AND item.quantity_delta > 0
  AND item.published_at IS NOT NULL
  AND item.published_at < applied.cutoff_at
  AND COALESCE(batch_item.product_line_id, catalog.product_line_id) IS NOT NULL
  AND COALESCE(batch_item.set_id, catalog.set_id) IS NOT NULL
  AND COALESCE(batch_item.product_id, catalog.product_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM inventory_publication_receipt_links link
    WHERE link.publication_item_id = item.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM inventory_listing_history_coverage covered
    WHERE covered.seller_key = applied.seller_key AND covered.sku = item.sku
  );

DROP TABLE IF EXISTS pg_temp.listing_history_skus;
CREATE TEMP TABLE listing_history_skus AS
WITH published AS (
  SELECT run_id, seller_key, cutoff_at, sku,
    MIN(published_at) AS covered_from,
    SUM(quantity_delta)::int AS published_quantity,
    MIN(product_line_id) AS product_line_id,
    MIN(set_id) AS set_id,
    MIN(product_id) AS product_id,
    array_agg(publication_item_id ORDER BY published_at, publication_item_id) AS publication_item_ids
  FROM listing_history_publications
  GROUP BY run_id, seller_key, cutoff_at, sku
)
SELECT published.*,
  opening.receipt_id AS opening_receipt_id,
  COALESCE(opening.original_quantity, 0) AS opening_quantity,
  COALESCE((
    SELECT SUM(line.ordered_quantity)::int
    FROM seller_orders orders
    JOIN seller_order_lines line ON line.order_id = orders.id
    WHERE orders.seller_key = published.seller_key
      AND line.sku_id = published.sku::text
      AND orders.order_time >= published.covered_from
      AND orders.order_time < published.cutoff_at
  ), 0) AS ordered_quantity
FROM published
LEFT JOIN inventory_receipts opening
  ON opening.opening_balance_run_id = published.run_id
  AND opening.sku = published.sku
  AND opening.receipt_kind = 'opening_balance';

DELETE FROM listing_history_skus
WHERE opening_quantity + ordered_quantity - published_quantity < 0;

DELETE FROM listing_history_publications publication
WHERE NOT EXISTS (
  SELECT 1 FROM listing_history_skus covered
  WHERE covered.seller_key = publication.seller_key AND covered.sku = publication.sku
);

-- One received lot per historical publication item, listed and valued at the
-- time its pricing result priced it.
INSERT INTO inventory_pending_mutations (
  request_id, mutation_type, sku, requested_quantity, expected_quantity,
  product_line_id, set_id, product_id, quantity_delta, resulting_quantity, recorded_at
)
SELECT
  'historical-publication:' || publication_item_id::text, 'add', sku, quantity_delta, NULL,
  product_line_id, set_id, product_id, quantity_delta, quantity_delta, NOW()
FROM listing_history_publications
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO inventory_receipts (
  request_id, sku, original_quantity, product_line_id, set_id, product_id, seller_key,
  intake_at, recorded_at, market_value, market_observed_at, market_calculated_at,
  market_provenance, source_evidence, receipt_kind, fifo_precedence
)
SELECT
  'historical-publication:' || publication_item_id::text, sku, quantity_delta,
  product_line_id, set_id, product_id, seller_key,
  published_at, NOW(), market_value, result_priced_at, market_calculated_at,
  CASE WHEN market_value IS NULL
    THEN 'historical_pricing_result_unavailable' ELSE 'historical_pricing_result' END,
  jsonb_strip_nulls(jsonb_build_object(
    'source', 'migration_045_historical_publication',
    'publicationItemId', publication_item_id,
    'batchNumber', batch_number,
    'candidateKey', candidate_key,
    'intakeBasis', 'publication_live_time',
    'sellerAttribution', seller_attribution
  )),
  'received', 1
FROM listing_history_publications
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO inventory_receipt_batch_links (receipt_id, batch_number, linked_quantity, linked_at)
SELECT receipt.receipt_id, publication.batch_number, publication.quantity_delta, NOW()
FROM listing_history_publications publication
JOIN inventory_receipts receipt
  ON receipt.request_id = 'historical-publication:' || publication.publication_item_id::text
WHERE publication.batch_number IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO inventory_publication_receipt_links (
  publication_item_id, receipt_id, planned_quantity, target_seller_key,
  live_at, activated_at, confirmation_evidence
)
SELECT
  publication.publication_item_id, receipt.receipt_id, publication.quantity_delta,
  publication.seller_key, publication.published_at, NOW(),
  jsonb_build_object(
    'source', 'migration_045_historical_publication',
    'publicationItemId', publication.publication_item_id,
    'sellerAttribution', publication.seller_attribution
  )
FROM listing_history_publications publication
JOIN inventory_receipts receipt
  ON receipt.request_id = 'historical-publication:' || publication.publication_item_id::text
ON CONFLICT DO NOTHING;

-- Unknown-origin units that were sold after the first covered publication but
-- were not in the opening export need an opening-balance lot to be sold from.
INSERT INTO inventory_pending_mutations (
  request_id, mutation_type, sku, requested_quantity, expected_quantity,
  product_line_id, set_id, product_id, quantity_delta, resulting_quantity, recorded_at
)
SELECT
  'historical-listing-unknown:' || run_id::text || ':' || sku::text, 'opening', sku,
  opening_quantity + ordered_quantity - published_quantity, NULL,
  product_line_id, set_id, product_id,
  opening_quantity + ordered_quantity - published_quantity,
  opening_quantity + ordered_quantity - published_quantity, NOW()
FROM listing_history_skus
WHERE opening_receipt_id IS NULL AND opening_quantity + ordered_quantity - published_quantity > 0
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO inventory_receipts (
  request_id, sku, original_quantity, product_line_id, set_id, product_id, seller_key,
  intake_at, recorded_at, market_value, market_observed_at, market_calculated_at,
  market_provenance, source_evidence, receipt_kind, opening_balance_run_id, fifo_precedence
)
SELECT
  'historical-listing-unknown:' || run_id::text || ':' || sku::text, sku,
  opening_quantity + ordered_quantity - published_quantity,
  product_line_id, set_id, product_id, seller_key,
  NULL, NOW(), NULL, NULL, NULL, 'listing_history_unknown',
  jsonb_build_object(
    'source', 'migration_045_pre_history_units',
    'coveredFrom', covered_from,
    'cutoffAt', cutoff_at
  ),
  'opening_balance', run_id, 0
FROM listing_history_skus
WHERE opening_receipt_id IS NULL AND opening_quantity + ordered_quantity - published_quantity > 0
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO inventory_listing_history_coverage (
  seller_key, sku, opening_balance_run_id, covered_from, published_quantity,
  ordered_quantity, opening_quantity, unknown_quantity, opening_receipt_id, evidence
)
SELECT
  covered.seller_key, covered.sku, covered.run_id, covered.covered_from, covered.published_quantity,
  covered.ordered_quantity, covered.opening_quantity,
  covered.opening_quantity + covered.ordered_quantity - covered.published_quantity,
  COALESCE(covered.opening_receipt_id, unknown_receipt.receipt_id),
  jsonb_build_object(
    'source', 'migration_045_historical_publication',
    'cutoffAt', covered.cutoff_at,
    'publicationItemIds', to_jsonb(covered.publication_item_ids)
  )
FROM listing_history_skus covered
LEFT JOIN inventory_receipts unknown_receipt
  ON unknown_receipt.request_id = 'historical-listing-unknown:' || covered.run_id::text || ':' || covered.sku::text
ON CONFLICT DO NOTHING;

INSERT INTO inventory_fifo_replay_queue (seller_key, sku, affected_from, status, generation)
SELECT seller_key, sku, covered_from, 'pending', 1
FROM listing_history_skus
ON CONFLICT (seller_key, sku) DO UPDATE SET
  affected_from = LEAST(inventory_fifo_replay_queue.affected_from, EXCLUDED.affected_from),
  generation = inventory_fifo_replay_queue.generation + 1,
  status = 'pending',
  claim_token = NULL,
  claim_expires_at = NULL,
  hold_reason = NULL,
  updated_at = NOW();

DROP TABLE IF EXISTS pg_temp.listing_history_publications;
DROP TABLE IF EXISTS pg_temp.listing_history_skus;