-- The shipping workflow in progress: the orders loaded and how far each has got (packed,
-- tracked, buyers told). The React screen kept it in each browser's localStorage; the Corten
-- screen keeps it here, so a reload, a second tab or another computer continues the same batch.
CREATE TABLE IF NOT EXISTS shipping_workflows (
  workflow_key TEXT PRIMARY KEY,
  workflow_json JSONB NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
