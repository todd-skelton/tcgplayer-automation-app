CREATE TABLE IF NOT EXISTS inventory_batches (
  batch_number INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_priced_at TIMESTAMPTZ,
  last_percentile_used INTEGER,
  summary_json JSONB,
  successful_count INTEGER NOT NULL DEFAULT 0,
  manual_review_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_batch_items (
  batch_number INTEGER NOT NULL REFERENCES inventory_batches(batch_number) ON DELETE CASCADE,
  sku INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  product_line_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (batch_number, sku)
);

CREATE TABLE IF NOT EXISTS inventory_batch_results (
  batch_number INTEGER NOT NULL REFERENCES inventory_batches(batch_number) ON DELETE CASCADE,
  sku INTEGER NOT NULL,
  result_status TEXT NOT NULL,
  row_json JSONB NOT NULL,
  error_messages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  warning_messages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  priced_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (batch_number, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_created_at
  ON inventory_batches (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_batches_last_priced_at
  ON inventory_batches (last_priced_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_items_batch_number
  ON inventory_batch_items (batch_number);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_items_product_line_id
  ON inventory_batch_items (product_line_id);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_results_batch_status
  ON inventory_batch_results (batch_number, result_status);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_results_priced_at
  ON inventory_batch_results (priced_at DESC);
