CREATE TABLE IF NOT EXISTS continuous_pricing_inventory (
  seller_key TEXT NOT NULL,
  sku INTEGER NOT NULL CHECK (sku > 0),
  product_id INTEGER NOT NULL CHECK (product_id > 0),
  product_line_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  product_line TEXT NOT NULL,
  set_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  condition TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  current_price NUMERIC(12, 2) CHECK (
    current_price IS NULL OR current_price > 0
  ),
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pause_reason TEXT,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_priced_at TIMESTAMPTZ,
  last_published_price NUMERIC(12, 2),
  last_published_at TIMESTAMPTZ,
  next_price_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_batch_number INTEGER
    REFERENCES inventory_batches(batch_number) ON DELETE SET NULL,
  consecutive_pricing_failures INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seller_key, sku)
);

CREATE INDEX IF NOT EXISTS idx_continuous_pricing_inventory_due
  ON continuous_pricing_inventory (
    next_price_at,
    seller_key,
    sku
  )
  WHERE enabled AND in_stock AND pause_reason IS NULL;

CREATE INDEX IF NOT EXISTS idx_continuous_pricing_inventory_last_observed
  ON continuous_pricing_inventory (seller_key, last_observed_at);

CREATE TABLE IF NOT EXISTS continuous_pricing_refreshes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('refreshing', 'completed', 'failed')),
  observed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_continuous_pricing_refreshes_seller
  ON continuous_pricing_refreshes (seller_key, started_at DESC);
