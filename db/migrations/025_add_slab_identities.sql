CREATE TABLE slab_identities (
  id uuid PRIMARY KEY,
  grader text NOT NULL,
  certificate_number text NOT NULL,
  candidate jsonb,
  identity jsonb,
  status text NOT NULL DEFAULT 'needs-review' CHECK (status IN ('needs-review', 'confirmed')),
  review_reasons jsonb NOT NULL DEFAULT '[]',
  valuation_group_key text,
  revision integer NOT NULL DEFAULT 1,
  decision_source text NOT NULL DEFAULT 'alt' CHECK (decision_source IN ('alt', 'manual')),
  decision_note text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (grader, certificate_number),
  CHECK (status <> 'confirmed' OR (identity IS NOT NULL AND valuation_group_key IS NOT NULL))
);
