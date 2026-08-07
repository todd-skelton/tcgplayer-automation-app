ALTER TABLE inventory_batch_pricing_jobs
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;

UPDATE inventory_batch_pricing_jobs job
SET priority = CASE batch.source_type
  WHEN 'pending_inventory' THEN 300
  WHEN 'seller' THEN 200
  WHEN 'csv' THEN 200
  ELSE 0
END
FROM inventory_batches batch
WHERE batch.batch_number = job.batch_number
  AND job.priority = 0
  AND batch.source_type <> 'continuous';

CREATE INDEX IF NOT EXISTS idx_inventory_batch_pricing_jobs_claim
  ON inventory_batch_pricing_jobs (
    status,
    priority DESC,
    created_at ASC,
    id ASC
  );
