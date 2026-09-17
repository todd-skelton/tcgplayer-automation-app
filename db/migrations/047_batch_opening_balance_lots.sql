-- Opening-balance lots predate any intake record, so they never joined a batch
-- and could not carry a purchase cost. One batch per seller gathers them so the
-- estimated purchase cost rule can value them from the market observed when the
-- seller's inventory was first tracked. Lots without a seller take the seller
-- whose continuous pricing inventory tracks the SKU.
WITH opening_seller AS (
  SELECT receipt.receipt_id,
    COALESCE(receipt.seller_key,
      (SELECT observed.seller_key FROM continuous_pricing_inventory observed
       WHERE observed.sku=receipt.sku ORDER BY observed.created_at LIMIT 1)) AS seller_key
  FROM inventory_receipts receipt
  WHERE receipt.receipt_kind='opening_balance'
    AND NOT EXISTS (SELECT 1 FROM inventory_receipt_batch_links link WHERE link.receipt_id=receipt.receipt_id)
), opening_batch AS (
  INSERT INTO inventory_batches (status,source_type,source_label,source_request_id)
  SELECT 'priced','opening_balance','Opening balance for seller '||seller_key,'opening-balance:'||seller_key
  FROM (SELECT DISTINCT seller_key FROM opening_seller WHERE seller_key IS NOT NULL) sellers
  ON CONFLICT (source_request_id) WHERE source_request_id IS NOT NULL DO NOTHING
  RETURNING batch_number,source_request_id
)
INSERT INTO inventory_receipt_batch_links (receipt_id,batch_number,linked_quantity)
SELECT opening_seller.receipt_id,batch.batch_number,receipt.original_quantity
FROM opening_seller
JOIN inventory_receipts receipt ON receipt.receipt_id=opening_seller.receipt_id
JOIN inventory_batches batch ON batch.source_request_id='opening-balance:'||opening_seller.seller_key
WHERE opening_seller.seller_key IS NOT NULL AND receipt.original_quantity>0
ON CONFLICT DO NOTHING;