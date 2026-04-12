ALTER TABLE shipping_postage_purchases
  DROP CONSTRAINT IF EXISTS shipping_postage_purchases_direction_check;

ALTER TABLE shipping_postage_purchases
  ADD CONSTRAINT shipping_postage_purchases_direction_check
  CHECK (direction IN ('outbound', 'return'));
