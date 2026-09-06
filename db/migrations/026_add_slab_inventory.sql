CREATE TABLE slab_inventory_accounts (
  seller TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ
);

CREATE TABLE slab_inventory (
  id UUID PRIMARY KEY,
  seller TEXT NOT NULL REFERENCES slab_inventory_accounts(seller),
  item_id TEXT NOT NULL,
  variation_key TEXT NOT NULL DEFAULT '',
  snapshot JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ebay', 'csv', 'manual')),
  state TEXT NOT NULL CHECK (state IN ('active', 'ended', 'sold', 'missing')),
  revision INTEGER NOT NULL DEFAULT 1,
  identity_id UUID REFERENCES slab_identities(id),
  identity_source TEXT CHECK (identity_source IN ('certificate', 'manual')),
  identity_note TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (seller, item_id, variation_key)
);
CREATE INDEX slab_inventory_identity_idx ON slab_inventory(identity_id);
CREATE INDEX slab_inventory_active_idx ON slab_inventory(seller, item_id) WHERE state = 'active';
CREATE INDEX slab_inventory_certificate_idx ON slab_inventory(seller, (snapshot->'certificate')) WHERE state = 'active';
