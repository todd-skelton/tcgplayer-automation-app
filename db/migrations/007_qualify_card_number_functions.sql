CREATE OR REPLACE FUNCTION normalize_card_number(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN value IS NULL THEN NULL
    ELSE (
      SELECT string_agg(public.normalize_card_number_part(part), '/' ORDER BY ordinality)
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
    ELSE public.normalize_card_number_part(split_part(btrim(value), '/', 1))
  END
$$;
