CREATE TABLE IF NOT EXISTS shipping_postage_purchases (
  id BIGSERIAL PRIMARY KEY,
  shipment_reference TEXT NOT NULL,
  order_numbers TEXT[] NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'production')),
  direction TEXT NOT NULL CHECK (direction IN ('outbound')),
  label_size TEXT NOT NULL CHECK (label_size IN ('4x6', '7x3', '6x4')),
  easypost_shipment_id TEXT,
  tracking_code TEXT,
  selected_rate_service TEXT,
  selected_rate_rate TEXT,
  selected_rate_currency TEXT,
  label_url TEXT,
  label_pdf_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('purchased', 'failed', 'skipped')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shipping_postage_purchases_mode_status_created_idx
  ON shipping_postage_purchases (mode, status, created_at DESC);

CREATE INDEX IF NOT EXISTS shipping_postage_purchases_order_numbers_gin_idx
  ON shipping_postage_purchases USING GIN (order_numbers);
