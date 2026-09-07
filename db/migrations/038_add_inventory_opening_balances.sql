CREATE TABLE inventory_complete_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  source TEXT NOT NULL CHECK (source = 'seller_portal_live_export'),
  status TEXT NOT NULL CHECK (status IN ('complete', 'unstable', 'invalid')),
  quantity_semantics TEXT NOT NULL CHECK (quantity_semantics = 'sellable_excludes_reserved'),
  started_at TIMESTAMPTZ NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  quantity_fingerprint TEXT NOT NULL,
  first_content_fingerprint TEXT NOT NULL,
  second_content_fingerprint TEXT NOT NULL,
  sku_count INTEGER NOT NULL CHECK (sku_count >= 0),
  positive_sku_count INTEGER NOT NULL CHECK (positive_sku_count >= 0),
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  identity_evidence JSONB NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inventory_complete_observations_seller_cutoff_idx
  ON inventory_complete_observations (seller_key, cutoff_at DESC, id DESC)
  WHERE status = 'complete';

CREATE TABLE inventory_complete_observation_items (
  observation_id BIGINT NOT NULL REFERENCES inventory_complete_observations(id) ON DELETE RESTRICT,
  sku INTEGER NOT NULL CHECK (sku > 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (observation_id, sku)
);

CREATE TABLE inventory_complete_observation_requests (
  request_id TEXT PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  status TEXT NOT NULL CHECK (status IN ('capturing', 'complete', 'failed')),
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  observation_id BIGINT REFERENCES inventory_complete_observations(id) ON DELETE RESTRICT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'capturing' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND observation_id IS NULL)
    OR (status = 'complete' AND claim_token IS NULL AND claim_expires_at IS NULL AND observation_id IS NOT NULL)
    OR (status = 'failed' AND claim_token IS NULL AND claim_expires_at IS NULL AND observation_id IS NULL)
  )
);

CREATE TABLE inventory_observation_differences (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL,
  previous_observation_id BIGINT NOT NULL REFERENCES inventory_complete_observations(id) ON DELETE RESTRICT,
  observation_id BIGINT NOT NULL REFERENCES inventory_complete_observations(id) ON DELETE RESTRICT,
  sku INTEGER NOT NULL,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  previous_quantity INTEGER NOT NULL CHECK (previous_quantity >= 0),
  observed_quantity INTEGER NOT NULL CHECK (observed_quantity >= 0),
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','acknowledged')),
  acknowledgement_request_id TEXT UNIQUE,
  acknowledgement_note TEXT,
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (previous_observation_id, observation_id, sku)
);

CREATE INDEX inventory_observation_differences_unresolved_idx
  ON inventory_observation_differences (observation_id, id) WHERE status = 'unresolved';

CREATE TABLE inventory_opening_balance_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  observation_id BIGINT NOT NULL REFERENCES inventory_complete_observations(id) ON DELETE RESTRICT,
  -- Coverage runs are retention-bounded; this is copied evidence, not a live FK.
  order_coverage_run_id BIGINT,
  order_coverage_evidence JSONB,
  cutoff_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'blocked', 'applied')),
  evidence_fingerprint TEXT NOT NULL,
  unresolved JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX inventory_opening_balance_one_applied_seller_idx
  ON inventory_opening_balance_runs (seller_key) WHERE status = 'applied';

CREATE TABLE inventory_opening_balance_items (
  run_id BIGINT NOT NULL REFERENCES inventory_opening_balance_runs(id) ON DELETE RESTRICT,
  sku INTEGER NOT NULL,
  opening_quantity INTEGER NOT NULL CHECK (opening_quantity >= 0),
  product_line_id INTEGER,
  set_id INTEGER,
  product_id INTEGER,
  receipt_id INTEGER,
  CHECK (
    (product_line_id IS NULL AND set_id IS NULL AND product_id IS NULL)
    OR (product_line_id IS NOT NULL AND set_id IS NOT NULL AND product_id IS NOT NULL)
  ),
  PRIMARY KEY (run_id, sku)
);

ALTER TABLE inventory_pending_mutations
  DROP CONSTRAINT inventory_pending_mutations_mutation_type_check,
  ADD CONSTRAINT inventory_pending_mutations_mutation_type_check
    CHECK (mutation_type IN ('add', 'remove', 'set', 'clear', 'opening'));

ALTER TABLE inventory_receipts
  ADD COLUMN receipt_kind TEXT NOT NULL DEFAULT 'received'
    CHECK (receipt_kind IN ('received', 'opening_balance')),
  ADD COLUMN opening_balance_run_id BIGINT
    REFERENCES inventory_opening_balance_runs(id) ON DELETE RESTRICT,
  ADD COLUMN fifo_precedence SMALLINT NOT NULL DEFAULT 1 CHECK (fifo_precedence IN (0, 1)),
  ADD CONSTRAINT inventory_receipts_opening_kind_check CHECK (
    (receipt_kind = 'opening_balance' AND opening_balance_run_id IS NOT NULL AND fifo_precedence = 0)
    OR (receipt_kind = 'received' AND opening_balance_run_id IS NULL AND fifo_precedence = 1)
  ),
  ADD CONSTRAINT inventory_receipts_opening_sku_unique UNIQUE (opening_balance_run_id, sku);

ALTER TABLE inventory_opening_balance_items
  ADD CONSTRAINT inventory_opening_balance_items_receipt_fk
  FOREIGN KEY (receipt_id) REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION preserve_inventory_receipt_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.sku IS DISTINCT FROM NEW.sku
    OR OLD.original_quantity IS DISTINCT FROM NEW.original_quantity
    OR OLD.intake_at IS DISTINCT FROM NEW.intake_at
    OR OLD.recorded_at IS DISTINCT FROM NEW.recorded_at
    OR OLD.market_value IS DISTINCT FROM NEW.market_value
    OR OLD.market_observed_at IS DISTINCT FROM NEW.market_observed_at
    OR OLD.market_calculated_at IS DISTINCT FROM NEW.market_calculated_at
    OR OLD.market_provenance IS DISTINCT FROM NEW.market_provenance
    OR OLD.source_evidence IS DISTINCT FROM NEW.source_evidence
    OR OLD.receipt_kind IS DISTINCT FROM NEW.receipt_kind
    OR OLD.opening_balance_run_id IS DISTINCT FROM NEW.opening_balance_run_id
    OR OLD.fifo_precedence IS DISTINCT FROM NEW.fifo_precedence
  THEN RAISE EXCEPTION 'Inventory receipt evidence is immutable'; END IF;
  IF OLD.seller_key IS NOT NULL AND OLD.seller_key IS DISTINCT FROM NEW.seller_key
  THEN RAISE EXCEPTION 'Inventory receipt seller ownership cannot be reassigned'; END IF;
  RETURN NEW;
END;
$$;
