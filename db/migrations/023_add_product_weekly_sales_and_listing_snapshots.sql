-- A year of weekly sales per SKU from the annual price history pricing
-- already fetches. Each row is every sale of one condition in one week:
-- how many, and the lowest and highest price paid. Weeks without a sale
-- are not stored. The current week is rewritten as it fills.
CREATE TABLE IF NOT EXISTS product_weekly_sales (
  sku_id INTEGER NOT NULL CHECK (sku_id > 0),
  product_id INTEGER NOT NULL CHECK (product_id > 0),
  condition TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  week_start DATE NOT NULL,
  transactions INTEGER NOT NULL CHECK (transactions > 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  low_sale_price NUMERIC(12, 2),
  high_sale_price NUMERIC(12, 2),
  low_sale_price_with_shipping NUMERIC(12, 2),
  high_sale_price_with_shipping NUMERIC(12, 2),
  tcg_market_price NUMERIC(12, 2),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sku_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_product_weekly_sales_product_week
  ON product_weekly_sales (product_id, week_start);

-- The competing asks pricing sees for a product, summarized per condition
-- once a day: how many other sellers list it under the sales ceiling, and
-- the two cheapest delivered prices. The last fetch of the day wins.
CREATE TABLE IF NOT EXISTS product_listing_snapshots (
  product_id INTEGER NOT NULL CHECK (product_id > 0),
  variant TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  condition TEXT NOT NULL,
  observed_on DATE NOT NULL,
  seller_count INTEGER NOT NULL CHECK (seller_count >= 0),
  cheapest_delivered_price NUMERIC(12, 2),
  second_cheapest_delivered_price NUMERIC(12, 2),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, variant, language, condition, observed_on)
);
