UPDATE pricing_config
SET pricing_json = pricing_json || jsonb_build_object(
  'minPercentile', 5,
  'maxPercentile', 95,
  'percentileStep', 5
),
updated_at = NOW()
WHERE config_key = 'default'
  AND pricing_json->>'minPercentile' = '10'
  AND pricing_json->>'maxPercentile' = '90'
  AND pricing_json->>'percentileStep' = '10';
