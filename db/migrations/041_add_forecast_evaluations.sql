CREATE TABLE forecast_evaluations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_key TEXT NOT NULL UNIQUE,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  target_version TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  fit_cutoff TIMESTAMPTZ NOT NULL,
  validation_cutoff TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('eligible','abstained')),
  report_json JSONB NOT NULL CHECK (jsonb_typeof(report_json) = 'object'),
  supersedes_id BIGINT REFERENCES forecast_evaluations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX forecast_evaluations_seller_evaluated_idx
  ON forecast_evaluations (seller_key, evaluated_at DESC, id DESC);

CREATE TABLE forecast_correction_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_key TEXT NOT NULL CHECK (length(trim(seller_key)) > 0),
  evaluation_id BIGINT NOT NULL REFERENCES forecast_evaluations(id) ON DELETE RESTRICT,
  correction_version TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activated','rolled_back')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX forecast_correction_events_seller_created_idx
  ON forecast_correction_events (seller_key, created_at DESC, id DESC);

