-- A batch can override the rate its purchase cost is estimated at: a share of
-- each card's intake market less a fixed amount per card. Batches without a
-- row use the default rule. Like inventory_receipt_batch_links, this has no
-- foreign key to inventory_batches: deleting a pricing batch must not lose the
-- rate its cards are costed at.
CREATE TABLE inventory_batch_estimated_cost_rates (
  batch_number INTEGER PRIMARY KEY,
  market_rate NUMERIC(5,4) NOT NULL CHECK (market_rate BETWEEN 0 AND 1),
  per_unit_deduction_cents INTEGER NOT NULL CHECK (per_unit_deduction_cents BETWEEN 0 AND 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
