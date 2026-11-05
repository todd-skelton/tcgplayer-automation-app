SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'planningKey', p.planning_key, 'batch', p.batch_number, 'job', p.pricing_job_id, 'method', p.method,
    'source', p.source_type, 'seller', p.seller_key, 'status', p.status, 'config', p.config_json,
    'progress', p.progress_json, 'attempts', p.attempt_count,
    'items', (SELECT jsonb_agg(jsonb_build_object(
        'candidateKey', i.candidate_key, 'deltaKey', i.inventory_delta_key, 'batch', i.batch_number, 'sku', i.sku,
        'product', i.product_id, 'line', i.product_line, 'set', i.set_name, 'name', i.product_name,
        'condition', i.condition, 'previous', i.previous_price::text, 'desired', i.desired_price::text,
        'delta', i.quantity_delta, 'observed', i.observed_quantity, 'absolute', i.desired_absolute_quantity,
        'pricedAt', i.priced_at, 'reasons', i.eligibility_reasons, 'status', i.status,
        'forecast', i.forecast_evidence, 'provenance', i.forecast_evidence_provenance) ORDER BY i.sku)
      FROM inventory_publication_items i WHERE i.publication_id = p.id)
  ) ORDER BY p.id), '[]'::jsonb)::text
FROM inventory_publications p WHERE p.id > $1
