CREATE TABLE inventory_pending_mutations (
  request_id TEXT PRIMARY KEY,
  mutation_type TEXT NOT NULL CHECK (mutation_type IN ('add', 'remove', 'set', 'clear')),
  sku INTEGER,
  requested_quantity INTEGER,
  expected_quantity INTEGER,
  product_line_id INTEGER,
  set_id INTEGER,
  product_id INTEGER,
  quantity_delta INTEGER NOT NULL,
  resulting_quantity INTEGER NOT NULL CHECK (resulting_quantity >= 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (mutation_type = 'clear' AND sku IS NULL AND requested_quantity IS NULL AND expected_quantity IS NULL
      AND product_line_id IS NULL AND set_id IS NULL AND product_id IS NULL)
    OR
    (mutation_type <> 'clear' AND sku IS NOT NULL
      AND product_line_id IS NOT NULL AND set_id IS NOT NULL AND product_id IS NOT NULL)
  )
);

CREATE TABLE inventory_receipts (
  receipt_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES inventory_pending_mutations(request_id),
  sku INTEGER NOT NULL,
  original_quantity INTEGER NOT NULL CHECK (original_quantity > 0),
  product_line_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  seller_key TEXT,
  intake_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  market_value NUMERIC(12, 4),
  market_observed_at TIMESTAMPTZ,
  market_calculated_at TIMESTAMPTZ,
  market_provenance TEXT NOT NULL,
  source_evidence JSONB,
  CHECK (market_value IS NULL OR market_value >= 0),
  CHECK (seller_key IS NULL OR length(trim(seller_key)) > 0)
);

CREATE TABLE inventory_receipt_adjustments (
  adjustment_id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id),
  mutation_request_id TEXT NOT NULL REFERENCES inventory_pending_mutations(request_id),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('correction', 'clear')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mutation_request_id, receipt_id)
);

-- Deliberately no foreign key to inventory_batches: deleting a pricing batch
-- must not erase the durable receipt-to-batch evidence or make those units
-- pending again.
CREATE TABLE inventory_receipt_batch_links (
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id),
  batch_number INTEGER NOT NULL,
  linked_quantity INTEGER NOT NULL CHECK (linked_quantity > 0),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (receipt_id, batch_number)
);

CREATE INDEX inventory_receipts_pending_order_idx
  ON inventory_receipts (sku, intake_at NULLS FIRST, receipt_id);
CREATE INDEX inventory_receipts_seller_sku_idx
  ON inventory_receipts (seller_key, sku)
  WHERE seller_key IS NOT NULL;
CREATE INDEX inventory_receipt_adjustments_receipt_idx
  ON inventory_receipt_adjustments (receipt_id);
CREATE INDEX inventory_receipt_batch_links_batch_idx
  ON inventory_receipt_batch_links (batch_number, receipt_id);

CREATE FUNCTION preserve_inventory_receipt_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
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
  THEN
    RAISE EXCEPTION 'Inventory receipt evidence is immutable';
  END IF;

  IF OLD.seller_key IS NOT NULL AND OLD.seller_key IS DISTINCT FROM NEW.seller_key THEN
    RAISE EXCEPTION 'Inventory receipt seller ownership cannot be reassigned';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_receipt_evidence_is_immutable
BEFORE UPDATE ON inventory_receipts
FOR EACH ROW
EXECUTE FUNCTION preserve_inventory_receipt_evidence();

-- Existing aggregate rows establish quantity only. Their old timestamps are
-- retained as evidence, but are not promoted to exact intake timestamps.
INSERT INTO inventory_pending_mutations (
  request_id,
  mutation_type,
  sku,
  requested_quantity,
  expected_quantity,
  product_line_id,
  set_id,
  product_id,
  quantity_delta,
  resulting_quantity,
  recorded_at
)
SELECT
  'legacy-pending:' || sku::text,
  'add',
  sku,
  quantity,
  NULL,
  product_line_id,
  set_id,
  product_id,
  quantity,
  quantity,
  NOW()
FROM pending_inventory
WHERE quantity > 0;

INSERT INTO inventory_receipts (
  request_id,
  sku,
  original_quantity,
  product_line_id,
  set_id,
  product_id,
  intake_at,
  recorded_at,
  market_value,
  market_observed_at,
  market_calculated_at,
  market_provenance,
  source_evidence
)
SELECT
  'legacy-pending:' || sku::text,
  sku,
  quantity,
  product_line_id,
  set_id,
  product_id,
  NULL,
  NOW(),
  NULL,
  NULL,
  NULL,
  'legacy_unavailable',
  jsonb_build_object(
    'legacyPendingCreatedAt', created_at,
    'legacyPendingUpdatedAt', updated_at
  )
FROM pending_inventory
WHERE quantity > 0;

ALTER TABLE inventory_batches
  ADD COLUMN source_request_id TEXT;

CREATE UNIQUE INDEX inventory_batches_source_request_idx
  ON inventory_batches (source_request_id)
  WHERE source_request_id IS NOT NULL;

CREATE TABLE inventory_batch_intake_requests (
  request_id TEXT PRIMARY KEY,
  batch_number INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
