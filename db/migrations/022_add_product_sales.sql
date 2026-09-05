-- Every sale the pricing runs fetch from TCGplayer, kept once. The latest
-- sales endpoint returns a rolling window, so recording each response builds
-- a sale-level history without extra requests.
CREATE TABLE IF NOT EXISTS product_sales (
  product_id INTEGER NOT NULL CHECK (product_id > 0),
  order_date TIMESTAMPTZ NOT NULL,
  condition TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  purchase_price NUMERIC(12, 2) NOT NULL CHECK (purchase_price >= 0),
  shipping_price NUMERIC(12, 2) NOT NULL CHECK (shipping_price >= 0),
  listing_type TEXT NOT NULL DEFAULT '',
  custom_listing_id TEXT NOT NULL DEFAULT '',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    product_id,
    order_date,
    condition,
    variant,
    language,
    quantity,
    purchase_price,
    shipping_price,
    listing_type,
    custom_listing_id
  )
);
