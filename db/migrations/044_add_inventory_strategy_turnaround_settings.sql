CREATE TABLE inventory_strategy_turnaround_settings (
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  scope_key TEXT NOT NULL,
  product_line_id INTEGER,
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'observed')),
  manual_turnaround_days NUMERIC(8, 3) NOT NULL
    CHECK (manual_turnaround_days >= 0 AND manual_turnaround_days <= 3650),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seller_key, scope_key),
  CHECK (scope_key = CASE
    WHEN product_line_id IS NULL THEN 'all'
    ELSE 'line:' || product_line_id::text
  END)
);

CREATE INDEX inventory_strategy_turnaround_settings_seller_idx
  ON inventory_strategy_turnaround_settings (seller_key, product_line_id);
