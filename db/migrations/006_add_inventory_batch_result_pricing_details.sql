ALTER TABLE inventory_batch_results
ADD COLUMN IF NOT EXISTS pricing_details_json JSONB;
