CREATE TABLE slab_seller_outcomes (
  seller TEXT NOT NULL REFERENCES slab_inventory_accounts(seller),
  event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  item_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  payload JSONB NOT NULL CHECK(pg_column_size(payload) <= 8192),
  PRIMARY KEY(seller,event_id,content_hash)
);
CREATE INDEX slab_seller_outcome_item_idx ON slab_seller_outcomes(seller,item_id,event_id);
