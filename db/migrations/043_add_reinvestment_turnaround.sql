CREATE TABLE inventory_reinvestment_rebuilds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  rule_version TEXT NOT NULL CHECK (length(trim(rule_version)) > 0),
  effective_as_of TIMESTAMPTZ NOT NULL,
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64),
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_key, rule_version, effective_as_of, source_fingerprint)
);

CREATE TABLE inventory_reinvestment_allocations (
  rebuild_id BIGINT NOT NULL REFERENCES inventory_reinvestment_rebuilds(id) ON DELETE RESTRICT,
  sample_key TEXT NOT NULL CHECK (length(sample_key) = 64),
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  order_number TEXT NOT NULL,
  purchase_reference TEXT NOT NULL,
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  sold_at TIMESTAMPTZ NOT NULL,
  funding_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  allocation_state TEXT NOT NULL CHECK (allocation_state IN ('completed','waiting')),
  timing_basis TEXT NOT NULL CHECK (timing_basis IN ('known_purchase','known_funding','sale_to_publication_inference')),
  proceeds_provenance TEXT NOT NULL CHECK (proceeds_provenance IN ('actual','estimated')),
  cost_provenance TEXT NOT NULL CHECK (cost_provenance IN ('actual','estimated')),
  funding_provenance TEXT NOT NULL CHECK (funding_provenance IN ('actual','estimated','inferred')),
  funding_adjustment_reference TEXT,
  explanation TEXT NOT NULL,
  source_identities JSONB NOT NULL CHECK (jsonb_typeof(source_identities) = 'array'),
  PRIMARY KEY (rebuild_id, sample_key)
);

CREATE TABLE inventory_reinvestment_current_rebuilds (
  seller_key TEXT PRIMARY KEY CHECK (length(trim(seller_key)) > 0),
  rebuild_id BIGINT NOT NULL UNIQUE REFERENCES inventory_reinvestment_rebuilds(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inventory_reinvestment_allocations_seller_state_idx
  ON inventory_reinvestment_allocations (seller_key, currency, allocation_state, sold_at);

CREATE FUNCTION preserve_inventory_reinvestment_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Inventory reinvestment evidence is immutable';
END;
$$;

CREATE TRIGGER inventory_reinvestment_rebuilds_are_immutable
BEFORE UPDATE OR DELETE ON inventory_reinvestment_rebuilds
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_reinvestment_evidence();

CREATE TRIGGER inventory_reinvestment_allocations_are_immutable
BEFORE UPDATE OR DELETE ON inventory_reinvestment_allocations
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_reinvestment_evidence();
