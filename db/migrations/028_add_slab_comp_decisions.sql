CREATE TABLE slab_comp_decisions (
  revision_id UUID NOT NULL REFERENCES slab_evidence_revisions(id),
  valuation_group_key TEXT NOT NULL,
  event_key TEXT NOT NULL,
  decision JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (revision_id, valuation_group_key, event_key)
);
CREATE INDEX slab_comp_decision_group_idx ON slab_comp_decisions(valuation_group_key, revision_id);
