CREATE TABLE IF NOT EXISTS product_lines (
  product_line_id INTEGER PRIMARY KEY,
  product_line_name TEXT NOT NULL,
  product_line_url_name TEXT NOT NULL UNIQUE,
  is_direct BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS category_sets (
  set_name_id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  clean_set_name TEXT NOT NULL,
  url_name TEXT NOT NULL,
  abbreviation TEXT,
  release_date TEXT,
  is_supplemental BOOLEAN NOT NULL,
  active BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS set_products (
  product_id INTEGER PRIMARY KEY,
  set_name_id INTEGER NOT NULL,
  game TEXT NOT NULL,
  number TEXT NOT NULL,
  product_name TEXT NOT NULL,
  rarity TEXT NOT NULL,
  set_name TEXT NOT NULL,
  set_abbrv TEXT NOT NULL,
  type TEXT NOT NULL,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS products (
  product_id INTEGER PRIMARY KEY,
  product_type_name TEXT NOT NULL,
  rarity_name TEXT NOT NULL,
  sealed BOOLEAN NOT NULL,
  product_name TEXT NOT NULL,
  set_id INTEGER NOT NULL,
  set_code TEXT NOT NULL,
  set_name TEXT NOT NULL,
  product_line_id INTEGER NOT NULL,
  product_status_id INTEGER NOT NULL,
  product_line_name TEXT NOT NULL,
  skus_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skus (
  sku INTEGER PRIMARY KEY,
  condition TEXT NOT NULL,
  variant TEXT NOT NULL,
  language TEXT NOT NULL,
  product_type_name TEXT NOT NULL,
  rarity_name TEXT NOT NULL,
  sealed BOOLEAN NOT NULL,
  product_name TEXT NOT NULL,
  set_id INTEGER NOT NULL,
  set_code TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
  set_name TEXT NOT NULL,
  product_line_id INTEGER NOT NULL,
  product_status_id INTEGER NOT NULL,
  product_line_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS category_filters (
  category_id INTEGER PRIMARY KEY,
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  languages JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS pending_inventory (
  sku INTEGER PRIMARY KEY,
  quantity INTEGER NOT NULL,
  product_line_id INTEGER NOT NULL,
  set_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS http_config (
  config_key TEXT PRIMARY KEY,
  tcg_auth_cookie TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  domain_configs JSONB NOT NULL DEFAULT '{}'::jsonb,
  adaptive_config JSONB NOT NULL DEFAULT '{}'::jsonb
);
