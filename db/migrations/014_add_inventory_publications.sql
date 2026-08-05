CREATE TABLE IF NOT EXISTS inventory_publications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  planning_key TEXT NOT NULL UNIQUE,
  batch_number INTEGER REFERENCES inventory_batches(batch_number) ON DELETE RESTRICT,
  pricing_job_id BIGINT REFERENCES inventory_batch_pricing_jobs(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('staged_delta', 'direct_absolute')),
  source_type TEXT NOT NULL CHECK (
    source_type IN ('pending_inventory', 'seller', 'csv', 'continuous')
  ),
  seller_key TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN (
      'planned',
      'staging',
      'staged',
      'publishing',
      'published',
      'ambiguous',
      'failed',
      'rolled_back'
    )
  ),
  staged_pricing_upload_id INTEGER,
  config_json JSONB NOT NULL DEFAULT '{}'::JSONB,
  progress_json JSONB,
  error_code TEXT,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_expires_at TIMESTAMPTZ,
  staged_at TIMESTAMPTZ,
  publishing_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_publication_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_id BIGINT NOT NULL
    REFERENCES inventory_publications(id) ON DELETE RESTRICT,
  candidate_key TEXT NOT NULL UNIQUE,
  inventory_delta_key TEXT UNIQUE,
  batch_number INTEGER REFERENCES inventory_batches(batch_number) ON DELETE RESTRICT,
  sku INTEGER NOT NULL CHECK (sku > 0),
  product_id INTEGER NOT NULL CHECK (product_id > 0),
  product_line TEXT NOT NULL,
  set_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  condition TEXT NOT NULL,
  previous_price NUMERIC(12, 2),
  desired_price NUMERIC(12, 2) NOT NULL CHECK (desired_price > 0),
  quantity_delta INTEGER NOT NULL DEFAULT 0,
  observed_quantity INTEGER CHECK (
    observed_quantity IS NULL OR observed_quantity >= 0
  ),
  desired_absolute_quantity INTEGER CHECK (
    desired_absolute_quantity IS NULL OR desired_absolute_quantity >= 0
  ),
  priced_at TIMESTAMPTZ NOT NULL,
  eligibility_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'planned' CHECK (
    status IN (
      'planned',
      'manual_review',
      'superseded',
      'published',
      'ambiguous',
      'failed'
    )
  ),
  error_code TEXT,
  error_message TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (quantity_delta = 0 AND inventory_delta_key IS NULL)
    OR
    (quantity_delta <> 0 AND inventory_delta_key IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS inventory_publications_status_created_idx
  ON inventory_publications (status, created_at);

CREATE INDEX IF NOT EXISTS inventory_publications_claim_expires_idx
  ON inventory_publications (claim_expires_at)
  WHERE claim_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_publications_batch_idx
  ON inventory_publications (batch_number, created_at DESC);

CREATE INDEX IF NOT EXISTS inventory_publications_pricing_job_idx
  ON inventory_publications (pricing_job_id);

CREATE INDEX IF NOT EXISTS inventory_publications_upload_idx
  ON inventory_publications (staged_pricing_upload_id)
  WHERE staged_pricing_upload_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_publication_items_publication_status_idx
  ON inventory_publication_items (publication_id, status);

CREATE INDEX IF NOT EXISTS inventory_publication_items_sku_created_idx
  ON inventory_publication_items (sku, created_at DESC);
