ALTER TABLE continuous_pricing_inventory
  ADD COLUMN IF NOT EXISTS pricing_eligible BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_continuous_pricing_inventory_strategy
  ON continuous_pricing_inventory (seller_key, product_line, sku)
  WHERE in_stock AND quantity > 0;

CREATE TABLE IF NOT EXISTS inventory_strategy_pricing_curves (
  seller_key TEXT NOT NULL,
  sku INTEGER NOT NULL CHECK (sku > 0),
  batch_number INTEGER
    REFERENCES inventory_batches(batch_number) ON DELETE SET NULL,
  pricing_details_json JSONB NOT NULL,
  priced_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seller_key, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_strategy_pricing_curves_priced_at
  ON inventory_strategy_pricing_curves (seller_key, priced_at DESC);

INSERT INTO inventory_strategy_pricing_curves (
  seller_key,
  sku,
  batch_number,
  pricing_details_json,
  priced_at
)
SELECT DISTINCT ON (batch.source_label, result.sku)
  batch.source_label,
  result.sku,
  result.batch_number,
  result.pricing_details_json,
  result.priced_at
FROM inventory_batch_results result
JOIN inventory_batches batch
  ON batch.batch_number = result.batch_number
WHERE batch.source_type = 'continuous'
  AND result.result_status = 'successful'
  AND result.pricing_details_json IS NOT NULL
  AND CASE
    WHEN jsonb_typeof(result.pricing_details_json->'percentiles') = 'array'
    THEN jsonb_array_length(result.pricing_details_json->'percentiles') > 0
    ELSE FALSE
  END
ORDER BY batch.source_label, result.sku, result.priced_at DESC, result.batch_number DESC
ON CONFLICT (seller_key, sku) DO NOTHING;
