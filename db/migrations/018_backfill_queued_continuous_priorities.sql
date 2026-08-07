UPDATE inventory_batch_pricing_jobs job
SET priority = 100,
    updated_at = NOW()
FROM inventory_batches batch
WHERE batch.batch_number = job.batch_number
  AND batch.source_type = 'continuous'
  AND job.status = 'queued'
  AND job.priority < 100
  AND EXISTS (
    SELECT 1
    FROM continuous_pricing_inventory inventory
    WHERE inventory.last_batch_number = job.batch_number
      AND (
        inventory.last_priced_at IS NULL
        OR inventory.consecutive_pricing_failures > 0
      )
  );
