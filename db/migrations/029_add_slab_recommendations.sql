CREATE TABLE slab_recommendations (
  id UUID PRIMARY KEY,
  input_key TEXT NOT NULL UNIQUE,
  slab_id UUID NOT NULL REFERENCES slab_identities(id),
  identity_revision INTEGER NOT NULL,
  valuation_group_key TEXT NOT NULL,
  calculation JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX slab_recommendation_identity_idx ON slab_recommendations(slab_id, created_at DESC);
CREATE TABLE slab_recommendation_evidence (
  recommendation_id UUID NOT NULL REFERENCES slab_recommendations(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES slab_evidence_revisions(id),
  PRIMARY KEY (recommendation_id, revision_id)
);
CREATE TABLE slab_price_overrides (
  recommendation_id UUID PRIMARY KEY REFERENCES slab_recommendations(id),
  item_price NUMERIC NOT NULL CHECK (item_price > 0),
  currency TEXT NOT NULL,
  note TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
