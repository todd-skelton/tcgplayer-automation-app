CREATE TABLE slab_supply_versions (
  hash TEXT PRIMARY KEY,
  listing_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE slab_supply_scans (
  id UUID PRIMARY KEY,
  source_key TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('alt','ebayResearch')),
  valuation_group_key TEXT,
  asset_id TEXT,
  captured_at TIMESTAMPTZ NOT NULL,
  complete BOOLEAN NOT NULL,
  reported_count INTEGER NOT NULL,
  stored_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX slab_supply_scan_source_idx ON slab_supply_scans(source_key,captured_at DESC,id DESC);
CREATE INDEX slab_supply_scan_age_idx ON slab_supply_scans(captured_at);
CREATE TABLE slab_supply_observations (
  scan_id UUID NOT NULL REFERENCES slab_supply_scans(id) ON DELETE CASCADE,
  listing_key TEXT NOT NULL,
  version_hash TEXT NOT NULL REFERENCES slab_supply_versions(hash),
  position SMALLINT NOT NULL,
  PRIMARY KEY(scan_id,listing_key)
);
CREATE INDEX slab_supply_observation_version_idx ON slab_supply_observations(version_hash);
CREATE INDEX slab_supply_observation_listing_idx ON slab_supply_observations(listing_key,scan_id);
ALTER TABLE slab_evidence_revisions ADD COLUMN supply_scan_id UUID REFERENCES slab_supply_scans(id);
CREATE INDEX slab_evidence_supply_scan_idx ON slab_evidence_revisions(supply_scan_id) WHERE supply_scan_id IS NOT NULL;
