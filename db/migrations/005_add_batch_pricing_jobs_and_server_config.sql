CREATE TABLE IF NOT EXISTS pricing_config (
  config_key TEXT PRIMARY KEY,
  pricing_json JSONB NOT NULL,
  supply_analysis_json JSONB NOT NULL,
  product_line_pricing_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_batch_pricing_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_number INTEGER NOT NULL REFERENCES inventory_batches(batch_number) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json JSONB NOT NULL,
  progress_json JSONB,
  summary_json JSONB,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_pricing_jobs_batch_number
  ON inventory_batch_pricing_jobs (batch_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_pricing_jobs_status
  ON inventory_batch_pricing_jobs (status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_inventory_batch_pricing_jobs_claim_expires_at
  ON inventory_batch_pricing_jobs (claim_expires_at);
