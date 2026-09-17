-- Links every unbatched opening-balance lot to its seller's opening-balance
-- batch created by migration 047. Kept separate because rows inserted by a
-- data-modifying CTE are not visible to the same statement.
INSERT INTO inventory_receipt_batch_links (receipt_id,batch_number,linked_quantity)
SELECT receipt.receipt_id,batch.batch_number,receipt.original_quantity
FROM inventory_receipts receipt
JOIN inventory_batches batch ON batch.source_request_id='opening-balance:'||COALESCE(receipt.seller_key,
  (SELECT observed.seller_key FROM continuous_pricing_inventory observed
   WHERE observed.sku=receipt.sku ORDER BY observed.created_at LIMIT 1))
WHERE receipt.receipt_kind='opening_balance' AND receipt.original_quantity>0
  AND NOT EXISTS (SELECT 1 FROM inventory_receipt_batch_links link WHERE link.receipt_id=receipt.receipt_id)
ON CONFLICT DO NOTHING;