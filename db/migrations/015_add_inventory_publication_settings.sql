CREATE TABLE IF NOT EXISTS inventory_publication_settings (
  config_key TEXT PRIMARY KEY,
  settings_json JSONB NOT NULL,
  authentication_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (authentication_status IN ('unknown', 'healthy', 'invalid')),
  circuit_open BOOLEAN NOT NULL DEFAULT FALSE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0),
  pause_reason TEXT,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  runtime_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (config_key = 'default')
);
