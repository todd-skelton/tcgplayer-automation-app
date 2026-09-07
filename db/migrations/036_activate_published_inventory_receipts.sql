CREATE TABLE inventory_publication_receipt_links (
  publication_item_id BIGINT NOT NULL
    REFERENCES inventory_publication_items(id) ON DELETE RESTRICT,
  receipt_id INTEGER NOT NULL
    REFERENCES inventory_receipts(receipt_id) ON DELETE RESTRICT,
  planned_quantity INTEGER NOT NULL CHECK (planned_quantity > 0),
  target_seller_key TEXT NOT NULL CHECK (length(trim(target_seller_key)) > 0),
  live_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  confirmation_evidence JSONB,
  PRIMARY KEY (publication_item_id, receipt_id),
  UNIQUE (receipt_id),
  CHECK (
    (live_at IS NULL AND activated_at IS NULL AND confirmation_evidence IS NULL)
    OR
    (live_at IS NOT NULL AND activated_at IS NOT NULL AND confirmation_evidence IS NOT NULL)
  )
);

CREATE INDEX inventory_publication_receipt_links_seller_live_idx
  ON inventory_publication_receipt_links (target_seller_key, live_at)
  WHERE live_at IS NOT NULL;

-- If receipt capture was deployed before this migration, preserve any already
-- confirmed publication whose exact batch/SKU receipt quantity and seller are
-- still provable. Rows without complete evidence remain deliberately unlinked.
WITH valid_items AS (
  SELECT item.id AS publication_item_id, publication.seller_key
  FROM inventory_publication_items item
  JOIN inventory_publications publication ON publication.id = item.publication_id
  JOIN inventory_receipt_batch_links batch_link
    ON batch_link.batch_number = item.batch_number
  JOIN inventory_receipts receipt
    ON receipt.receipt_id = batch_link.receipt_id AND receipt.sku = item.sku
  WHERE item.status = 'published'
    AND item.quantity_delta > 0
    AND item.published_at IS NOT NULL
    AND publication.source_type = 'pending_inventory'
    AND publication.seller_key IS NOT NULL
  GROUP BY item.id, item.quantity_delta, publication.seller_key
  HAVING SUM(batch_link.linked_quantity) = item.quantity_delta
    AND BOOL_AND(
      receipt.seller_key IS NULL OR receipt.seller_key = publication.seller_key
    )
)
UPDATE inventory_receipts receipt
SET seller_key = valid.seller_key
FROM valid_items valid
JOIN inventory_publication_items item ON item.id = valid.publication_item_id
JOIN inventory_receipt_batch_links batch_link
  ON batch_link.batch_number = item.batch_number
WHERE receipt.receipt_id = batch_link.receipt_id
  AND receipt.sku = item.sku
  AND receipt.seller_key IS NULL;

WITH valid_items AS (
  SELECT
    item.id AS publication_item_id,
    item.sku,
    item.batch_number,
    item.quantity_delta,
    item.status,
    item.published_at,
    publication.seller_key
  FROM inventory_publication_items item
  JOIN inventory_publications publication ON publication.id = item.publication_id
  JOIN inventory_receipt_batch_links batch_link
    ON batch_link.batch_number = item.batch_number
  JOIN inventory_receipts receipt
    ON receipt.receipt_id = batch_link.receipt_id AND receipt.sku = item.sku
  WHERE item.quantity_delta > 0
    AND publication.source_type = 'pending_inventory'
    AND publication.seller_key IS NOT NULL
    AND (item.status <> 'published' OR item.published_at IS NOT NULL)
  GROUP BY
    item.id,
    item.sku,
    item.batch_number,
    item.quantity_delta,
    item.status,
    item.published_at,
    publication.seller_key
  HAVING SUM(batch_link.linked_quantity) = item.quantity_delta
    AND BOOL_AND(
      receipt.seller_key IS NULL OR receipt.seller_key = publication.seller_key
    )
)
INSERT INTO inventory_publication_receipt_links (
  publication_item_id,
  receipt_id,
  planned_quantity,
  target_seller_key,
  live_at,
  activated_at,
  confirmation_evidence
)
SELECT
  valid.publication_item_id,
  batch_link.receipt_id,
  batch_link.linked_quantity,
  valid.seller_key,
  CASE WHEN valid.status = 'published' THEN valid.published_at ELSE NULL END,
  CASE WHEN valid.status = 'published' THEN NOW() ELSE NULL END,
  CASE
    WHEN valid.status = 'published' THEN jsonb_build_object(
      'source', 'migration_036_confirmed_publication',
      'publicationItemId', valid.publication_item_id
    )
    ELSE NULL
  END
FROM valid_items valid
JOIN inventory_receipt_batch_links batch_link
  ON batch_link.batch_number = valid.batch_number
JOIN inventory_receipts receipt
  ON receipt.receipt_id = batch_link.receipt_id AND receipt.sku = valid.sku
ON CONFLICT DO NOTHING;
