CREATE OR REPLACE FUNCTION normalize_card_number_part(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    WHEN btrim(value) ~ '^[0-9]+$' THEN
      CASE
        WHEN ltrim(btrim(value), '0') = '' THEN '0'
        ELSE ltrim(btrim(value), '0')
      END
    ELSE btrim(value)
  END
$$;

CREATE OR REPLACE FUNCTION normalize_card_number(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    ELSE (
      SELECT string_agg(normalize_card_number_part(part), '/' ORDER BY ordinality)
      FROM unnest(string_to_array(btrim(value), '/')) WITH ORDINALITY AS parts(part, ordinality)
    )
  END
$$;

CREATE OR REPLACE FUNCTION normalize_card_number_prefix(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    ELSE normalize_card_number_part(split_part(btrim(value), '/', 1))
  END
$$;

CREATE INDEX IF NOT EXISTS idx_set_products_number_prefix_normalized
  ON set_products (normalize_card_number_prefix(number));

CREATE INDEX IF NOT EXISTS idx_set_products_number_full_normalized
  ON set_products (normalize_card_number(number));
