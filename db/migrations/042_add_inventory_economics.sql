ALTER TABLE seller_orders
  ADD COLUMN gross_shipping_proceeds NUMERIC(12, 2),
  ADD COLUMN gross_order_proceeds NUMERIC(12, 2),
  ADD COLUMN platform_fee_amount NUMERIC(12, 2),
  ADD COLUMN provider_net_proceeds NUMERIC(12, 2),
  ADD COLUMN direct_fee_amount NUMERIC(12, 2),
  ADD COLUMN transaction_evidence JSONB;

ALTER TABLE seller_order_revisions
  ADD COLUMN transaction_evidence JSONB;

CREATE TABLE inventory_purchase_cost_series (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  purchase_reference TEXT NOT NULL CHECK (length(trim(purchase_reference)) > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_key, purchase_reference, currency)
);

CREATE TABLE inventory_purchase_cost_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id BIGINT NOT NULL REFERENCES inventory_purchase_cost_series(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  total_amount_cents BIGINT NOT NULL CHECK (total_amount_cents >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('actual','estimated')),
  source TEXT NOT NULL CHECK (source IN ('intake','manual','file_import')),
  allocation_rule TEXT NOT NULL CHECK (allocation_rule IN ('quantity','frozen_market','explicit')),
  batch_numbers INTEGER[] NOT NULL CHECK (cardinality(batch_numbers) > 0),
  purchased_at DATE,
  market_observed_at TIMESTAMPTZ,
  corrects_entry_id BIGINT UNIQUE REFERENCES inventory_purchase_cost_entries(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, sequence),
  CHECK ((allocation_rule = 'frozen_market') = (market_observed_at IS NOT NULL)),
  CHECK ((corrects_entry_id IS NULL) = (correction_reason IS NULL))
);

CREATE TABLE inventory_purchase_cost_allocations (
  entry_id BIGINT NOT NULL REFERENCES inventory_purchase_cost_entries(id) ON DELETE RESTRICT,
  receipt_id INTEGER NOT NULL REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  allocated_amount_cents BIGINT NOT NULL CHECK (allocated_amount_cents >= 0),
  allocation_weight NUMERIC(24, 8) NOT NULL CHECK (allocation_weight >= 0),
  PRIMARY KEY (entry_id, receipt_id)
);

CREATE INDEX inventory_purchase_cost_allocations_receipt_idx
  ON inventory_purchase_cost_allocations (receipt_id, entry_id);

CREATE TABLE inventory_funding_series (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  adjustment_reference TEXT NOT NULL CHECK (length(trim(adjustment_reference)) > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_key, adjustment_reference, currency)
);

CREATE TABLE inventory_funding_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id BIGINT NOT NULL REFERENCES inventory_funding_series(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN (
    'opening_cash','external_contribution','withdrawal','reserve','reserve_release','purchase_funding'
  )),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('actual','estimated')),
  effective_at DATE NOT NULL,
  purchase_reference TEXT,
  corrects_entry_id BIGINT UNIQUE REFERENCES inventory_funding_entries(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, sequence),
  CHECK ((adjustment_type = 'purchase_funding') = (purchase_reference IS NOT NULL)),
  CHECK ((corrects_entry_id IS NULL) = (correction_reason IS NULL))
);

CREATE TABLE inventory_order_expense_series (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  expense_reference TEXT NOT NULL CHECK (length(trim(expense_reference)) > 0),
  currency TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seller_key, expense_reference, currency)
);

CREATE TABLE inventory_order_expense_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id BIGINT NOT NULL REFERENCES inventory_order_expense_series(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE CHECK (length(trim(request_id)) > 0),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  expense_type TEXT NOT NULL CHECK (expense_type IN ('fulfillment','refund_settlement','other')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  provenance TEXT NOT NULL CHECK (provenance IN ('actual','estimated')),
  order_numbers TEXT[] NOT NULL CHECK (cardinality(order_numbers) > 0),
  expense_at DATE NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('additional_expense','original_net_refund_adjustment','already_adjusted_net')),
  corrects_entry_id BIGINT UNIQUE REFERENCES inventory_order_expense_entries(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (series_id, sequence),
  CHECK ((expense_type = 'refund_settlement') OR basis = 'additional_expense'),
  CHECK ((corrects_entry_id IS NULL) = (correction_reason IS NULL))
);

CREATE INDEX inventory_order_expense_entries_orders_idx
  ON inventory_order_expense_entries USING GIN (order_numbers);

CREATE FUNCTION preserve_inventory_economics_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Inventory economics evidence is immutable';
END;
$$;

CREATE TRIGGER inventory_purchase_cost_entries_are_immutable
BEFORE UPDATE OR DELETE ON inventory_purchase_cost_entries
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_economics_evidence();

CREATE TRIGGER inventory_purchase_cost_allocations_are_immutable
BEFORE UPDATE OR DELETE ON inventory_purchase_cost_allocations
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_economics_evidence();

CREATE TRIGGER inventory_funding_entries_are_immutable
BEFORE UPDATE OR DELETE ON inventory_funding_entries
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_economics_evidence();

CREATE TRIGGER inventory_order_expense_entries_are_immutable
BEFORE UPDATE OR DELETE ON inventory_order_expense_entries
FOR EACH ROW EXECUTE FUNCTION preserve_inventory_economics_evidence();
