CREATE TABLE seller_order_sync_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  source TEXT NOT NULL CHECK (source IN ('tcgplayer_api', 'file_import')),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'incomplete')),
  search_range TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  next_offset INTEGER NOT NULL DEFAULT 0 CHECK (next_offset >= 0),
  expected_total INTEGER CHECK (expected_total IS NULL OR expected_total >= 0),
  pages_completed INTEGER NOT NULL DEFAULT 0 CHECK (pages_completed >= 0),
  orders_observed INTEGER NOT NULL DEFAULT 0 CHECK (orders_observed >= 0),
  details_recorded INTEGER NOT NULL DEFAULT 0 CHECK (details_recorded >= 0),
  observed_from TIMESTAMPTZ,
  observed_through TIMESTAMPTZ,
  gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  error TEXT,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX seller_order_sync_runs_one_api_resume_idx
  ON seller_order_sync_runs (seller_key)
  WHERE source = 'tcgplayer_api' AND status IN ('running', 'incomplete');

CREATE INDEX seller_order_sync_runs_seller_started_idx
  ON seller_order_sync_runs (seller_key, started_at DESC);

CREATE TABLE seller_order_sync_run_orders (
  run_id BIGINT NOT NULL REFERENCES seller_order_sync_runs(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL,
  first_offset INTEGER NOT NULL CHECK (first_offset >= 0),
  PRIMARY KEY (run_id, order_number)
);

CREATE TABLE seller_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  order_number TEXT NOT NULL CHECK (length(trim(order_number)) > 0),
  order_time TIMESTAMPTZ NOT NULL,
  summary_order_time TIMESTAMPTZ,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN (
    'processing', 'ready_to_ship', 'shipped_in_transit',
    'shipped_delivered', 'completed_paid', 'canceled', 'unknown'
  )),
  provider_status TEXT NOT NULL,
  refund_status TEXT,
  order_channel TEXT,
  order_fulfillment TEXT,
  gross_item_proceeds NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision > 0),
  source_fingerprint TEXT NOT NULL,
  summary_fingerprint TEXT,
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  detail_observed_at TIMESTAMPTZ NOT NULL,
  latest_source TEXT NOT NULL CHECK (latest_source IN ('tcgplayer_api', 'file_import')),
  UNIQUE (seller_key, order_number)
);

CREATE INDEX seller_orders_seller_time_idx
  ON seller_orders (seller_key, order_time, order_number);

CREATE TABLE seller_order_lines (
  order_id BIGINT NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL CHECK (length(trim(sku_id)) > 0),
  product_id TEXT,
  product_name TEXT NOT NULL,
  ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity > 0),
  gross_item_proceeds NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (order_id, sku_id)
);

CREATE INDEX seller_order_lines_sku_idx ON seller_order_lines (sku_id, order_id);

CREATE TABLE seller_order_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES seller_orders(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  source_fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('tcgplayer_api', 'file_import')),
  observed_at TIMESTAMPTZ NOT NULL,
  summary_order_time TIMESTAMPTZ,
  provider_status TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  refund_status TEXT,
  refund_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  line_evidence JSONB NOT NULL,
  UNIQUE (order_id, revision_number),
  CHECK (jsonb_typeof(line_evidence) = 'array')
);

CREATE INDEX seller_order_revisions_observed_idx
  ON seller_order_revisions (observed_at, order_id);

CREATE TABLE seller_order_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  content_fingerprint TEXT NOT NULL,
  file_name TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  order_count INTEGER NOT NULL CHECK (order_count >= 0),
  line_count INTEGER NOT NULL CHECK (line_count >= 0),
  UNIQUE (seller_key, content_fingerprint)
);
