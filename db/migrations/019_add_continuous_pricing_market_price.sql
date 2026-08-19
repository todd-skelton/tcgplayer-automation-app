ALTER TABLE continuous_pricing_inventory
  ADD COLUMN IF NOT EXISTS market_price NUMERIC(12, 2) CHECK (
    market_price IS NULL OR market_price > 0
  );
