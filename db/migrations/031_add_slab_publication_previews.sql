CREATE TABLE slab_publication_previews (
  id UUID PRIMARY KEY,
  inventory_id UUID NOT NULL REFERENCES slab_inventory(id),
  recommendation_id UUID NOT NULL REFERENCES slab_recommendations(id),
  request JSONB NOT NULL,
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX slab_publication_preview_inventory_idx ON slab_publication_previews(inventory_id,created_at DESC,id DESC);
CREATE INDEX slab_publication_preview_expiry_idx ON slab_publication_previews(expires_at);
