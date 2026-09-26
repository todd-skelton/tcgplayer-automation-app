CREATE TABLE inventory_intake_runs (
  request_id TEXT PRIMARY KEY REFERENCES inventory_batch_intake_requests(request_id),
  batch_number INTEGER NOT NULL UNIQUE REFERENCES inventory_batches(batch_number) ON DELETE CASCADE,
  pricing_job_id BIGINT NOT NULL REFERENCES inventory_batch_pricing_jobs(id) ON DELETE CASCADE,
  workflow TEXT NOT NULL CHECK (workflow IN ('price_only', 'publish')),
  request_json JSONB NOT NULL,
  seller_key TEXT,
  planning_status TEXT NOT NULL DEFAULT 'waiting' CHECK (planning_status IN ('waiting', 'planned', 'needs_review')),
  planning_error TEXT,
  planning_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (workflow <> 'publish' OR (seller_key IS NOT NULL AND length(trim(seller_key)) > 0))
);
CREATE INDEX inventory_intake_runs_waiting_idx ON inventory_intake_runs(next_attempt_at)
  WHERE workflow = 'publish' AND planning_status = 'waiting';
