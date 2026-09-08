ALTER TABLE inventory_publication_items
  ADD COLUMN forecast_evidence JSONB,
  ADD COLUMN forecast_evidence_provenance TEXT NOT NULL DEFAULT 'unknown'
    CHECK (forecast_evidence_provenance IN ('recorded', 'estimated', 'unknown')),
  ADD CONSTRAINT inventory_publication_items_forecast_evidence_shape CHECK (
    (forecast_evidence IS NULL AND forecast_evidence_provenance = 'unknown')
    OR
    (jsonb_typeof(forecast_evidence) = 'object'
      AND forecast_evidence_provenance IN ('recorded', 'estimated'))
  );

CREATE INDEX inventory_fifo_revision_allocations_supply_idx
  ON inventory_fifo_revision_allocations (supply_key, revision_id);
