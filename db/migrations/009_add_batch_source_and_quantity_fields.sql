ALTER TABLE inventory_batches
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'pending_inventory',
  ADD COLUMN IF NOT EXISTS source_label TEXT;

UPDATE inventory_batches
SET source_label = 'Inventory Manager'
WHERE source_label IS NULL;

ALTER TABLE inventory_batches
  ALTER COLUMN source_label SET NOT NULL;

ALTER TABLE inventory_batch_items
  RENAME COLUMN quantity TO add_to_quantity;

ALTER TABLE inventory_batch_items
  ADD COLUMN IF NOT EXISTS total_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_price NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS original_row_json JSONB;
