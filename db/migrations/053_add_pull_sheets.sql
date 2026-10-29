-- Pull sheets uploaded to the Pull Sheet screen, kept so the screen has an address per sheet
-- (reload, back, a second tab) and lists the recent ones.
CREATE TABLE IF NOT EXISTS pull_sheets (
  pull_sheet_id BIGSERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  csv_text TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pull_sheets_uploaded_at_idx ON pull_sheets (uploaded_at DESC);
