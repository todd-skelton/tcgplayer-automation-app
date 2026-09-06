CREATE TABLE slab_maintenance_settings (
  seller TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  include_supply BOOLEAN NOT NULL DEFAULT false,
  interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK(interval_minutes BETWEEN 15 AND 1440),
  batch_size INTEGER NOT NULL DEFAULT 10 CHECK(batch_size BETWEEN 1 AND 25),
  refresh_budget INTEGER NOT NULL DEFAULT 20 CHECK(refresh_budget BETWEEN 1 AND 50),
  revision INTEGER NOT NULL DEFAULT 1,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  next_cycle_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_cycle_at TIMESTAMPTZ,
  last_error TEXT,
  last_summary JSONB
);
CREATE INDEX slab_maintenance_due_idx ON slab_maintenance_settings(next_cycle_at,seller) WHERE enabled;
CREATE TABLE slab_maintenance_items (
  inventory_id UUID PRIMARY KEY REFERENCES slab_inventory(id) ON DELETE CASCADE,
  inventory_revision INTEGER NOT NULL,
  identity_revision INTEGER,
  input_key TEXT,
  recommendation_id UUID REFERENCES slab_recommendations(id),
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  next_check_at TIMESTAMPTZ NOT NULL,
  settings_revision INTEGER NOT NULL
);
CREATE INDEX slab_maintenance_item_due_idx ON slab_maintenance_items(next_check_at,inventory_id);
