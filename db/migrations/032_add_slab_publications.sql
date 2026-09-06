CREATE TABLE slab_publications (
  id UUID PRIMARY KEY,
  preview_id UUID NOT NULL REFERENCES slab_publication_previews(id),
  restore_of UUID REFERENCES slab_publications(id),
  seller TEXT NOT NULL,
  item_id TEXT NOT NULL,
  variation_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('live','dry-run')),
  plan JSONB NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','approved','checking','writing','reconcile','confirmed','conflict','failed','cancelled','dry-run')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  write_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX slab_publication_active_listing_idx ON slab_publications(seller,item_id,variation_key)
  WHERE mode='live' AND state IN ('approved','checking','writing','reconcile');
CREATE INDEX slab_publication_preview_idx ON slab_publications(preview_id,created_at DESC,id DESC);
CREATE TABLE slab_publication_events (
  sequence BIGSERIAL PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES slab_publications(id),
  state TEXT NOT NULL,
  reason TEXT,
  observation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX slab_publication_event_idx ON slab_publication_events(publication_id,sequence DESC);
