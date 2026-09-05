CREATE TABLE slab_evidence_refreshes (
  key TEXT PRIMARY KEY,
  spec JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'idle', 'failed', 'cancelled')),
  run_id UUID NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  latest_revision UUID,
  fetched_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  error_code TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX slab_evidence_queue_idx ON slab_evidence_refreshes(priority DESC, available_at, key) WHERE state = 'queued';
CREATE INDEX slab_evidence_expired_lease_idx ON slab_evidence_refreshes(lease_until) WHERE state = 'running';

CREATE TABLE slab_evidence_revisions (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL REFERENCES slab_evidence_refreshes(key),
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL,
  byte_count INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  retained BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE slab_evidence_refreshes ADD CONSTRAINT slab_evidence_latest_revision_fk FOREIGN KEY(latest_revision) REFERENCES slab_evidence_revisions(id);
CREATE INDEX slab_evidence_latest_idx ON slab_evidence_refreshes(latest_revision) WHERE latest_revision IS NOT NULL;
CREATE INDEX slab_evidence_revision_key_idx ON slab_evidence_revisions(key, created_at DESC);
CREATE INDEX slab_evidence_revision_cleanup_idx ON slab_evidence_revisions(created_at) WHERE NOT retained;
