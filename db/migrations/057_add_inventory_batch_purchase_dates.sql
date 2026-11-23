-- online: a new table; the running release never reads it.
-- The day a batch's cards were bought, when the Inventory Manager was told it. The batch's
-- estimate prices each card at its market price from that week of its price history instead of
-- the market price when it was counted. Batches without a row are priced as they were counted.
-- Like inventory_batch_estimated_cost_rates, this has no foreign key to inventory_batches:
-- deleting a pricing batch must not lose the day its cards were bought.
CREATE TABLE IF NOT EXISTS inventory_batch_purchase_dates (
  batch_number INTEGER PRIMARY KEY,
  purchased_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
