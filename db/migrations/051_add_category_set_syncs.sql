CREATE TABLE category_set_syncs (
  set_name_id INTEGER PRIMARY KEY REFERENCES category_sets(set_name_id) ON DELETE CASCADE,
  verified_product_count INTEGER NOT NULL CHECK (verified_product_count >= 0),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
