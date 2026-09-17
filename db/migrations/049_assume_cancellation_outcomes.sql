-- A canceled order that never shipped never consumed stock; a canceled order
-- that shipped is a return that re-enters as new intake, so its sale stands.
-- FIFO now applies both rules itself instead of holding for a disposition.
ALTER TABLE inventory_fifo_lines DROP CONSTRAINT inventory_fifo_lines_state_check;
ALTER TABLE inventory_fifo_lines ADD CONSTRAINT inventory_fifo_lines_state_check
  CHECK (state IN ('pending','allocated','partial','unmatched','held','unsupported','excluded_pre_cutoff','removed','canceled_unfulfilled'));

-- Replay every SKU still held for a cancellation so the rules apply.
INSERT INTO inventory_fifo_replay_queue (seller_key, sku, affected_from, status, generation)
SELECT line.seller_key, line.sku, MIN(line.order_time), 'pending', 1
FROM inventory_fifo_lines line
WHERE line.state='held'
  AND line.hold_reason IN ('cancellation_requires_disposition','canceled_after_shipping_requires_restock')
GROUP BY line.seller_key, line.sku
ON CONFLICT (seller_key, sku) DO UPDATE SET
  affected_from = LEAST(inventory_fifo_replay_queue.affected_from, EXCLUDED.affected_from),
  generation = inventory_fifo_replay_queue.generation + 1,
  status = 'pending',
  claim_token = NULL,
  claim_expires_at = NULL,
  hold_reason = NULL,
  updated_at = NOW();