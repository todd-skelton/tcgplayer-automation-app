-- A batch can override the rate its purchase cost is estimated at: a share of
-- each card's intake market less a fixed amount per card. Null uses the
-- default rule.
ALTER TABLE inventory_batches
  ADD COLUMN estimated_cost_market_rate NUMERIC(5,4)
    CHECK (estimated_cost_market_rate BETWEEN 0 AND 1),
  ADD COLUMN estimated_cost_per_unit_deduction_cents INTEGER
    CHECK (estimated_cost_per_unit_deduction_cents BETWEEN 0 AND 10000),
  ADD CONSTRAINT inventory_batches_estimated_cost_rate_complete CHECK (
    (estimated_cost_market_rate IS NULL) = (estimated_cost_per_unit_deduction_cents IS NULL)
  );
