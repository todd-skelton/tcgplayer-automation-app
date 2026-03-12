CREATE INDEX IF NOT EXISTS idx_category_sets_category_id
  ON category_sets (category_id);

CREATE INDEX IF NOT EXISTS idx_category_sets_url_name
  ON category_sets (url_name);

CREATE INDEX IF NOT EXISTS idx_set_products_set_name_id
  ON set_products (set_name_id);

CREATE INDEX IF NOT EXISTS idx_products_product_line_id
  ON products (product_line_id);

CREATE INDEX IF NOT EXISTS idx_products_product_line_id_product_id
  ON products (product_line_id, product_id);

CREATE INDEX IF NOT EXISTS idx_products_set_id_product_line_id
  ON products (set_id, product_line_id);

CREATE INDEX IF NOT EXISTS idx_skus_product_line_id_sku
  ON skus (product_line_id, sku);

CREATE INDEX IF NOT EXISTS idx_skus_set_id_product_line_id
  ON skus (set_id, product_line_id);

CREATE INDEX IF NOT EXISTS idx_skus_product_id
  ON skus (product_id);

CREATE INDEX IF NOT EXISTS idx_pending_inventory_created_at
  ON pending_inventory (created_at);

CREATE INDEX IF NOT EXISTS idx_pending_inventory_product_line_id
  ON pending_inventory (product_line_id);

CREATE INDEX IF NOT EXISTS idx_pending_inventory_set_id
  ON pending_inventory (set_id);

CREATE INDEX IF NOT EXISTS idx_pending_inventory_product_id
  ON pending_inventory (product_id);
