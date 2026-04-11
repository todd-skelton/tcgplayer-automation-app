CREATE TABLE IF NOT EXISTS shipping_export_config (
  config_key TEXT PRIMARY KEY,
  settings_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
