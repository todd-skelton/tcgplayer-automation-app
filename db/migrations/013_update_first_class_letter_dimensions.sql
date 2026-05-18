UPDATE shipping_export_config
SET settings_json = jsonb_set(
  jsonb_set(
    jsonb_set(settings_json, '{letter,lengthIn}', '9'::jsonb),
    '{letter,widthIn}',
    '4'::jsonb
  ),
  '{letter,heightIn}',
  '0.25'::jsonb
)
WHERE settings_json #>> '{letter,lengthIn}' = '9.5'
  AND settings_json #>> '{letter,widthIn}' = '4.125';
