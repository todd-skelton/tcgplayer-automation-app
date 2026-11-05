SELECT jsonb_build_object(
  'refreshes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'key', r.key, 'spec', r.spec, 'state', r.state, 'priority', r.priority, 'attempts', r.attempts,
      'error', r.error_code, 'saved', r.latest_revision IS NOT NULL, 'fetched', r.fetched_at IS NOT NULL,
      'leased', r.lease_id IS NOT NULL,
      'ttl', round(extract(epoch FROM r.expires_at - r.fetched_at)),
      'wait', round(extract(epoch FROM r.available_at - r.updated_at)),
      'duration', r.duration_ms) ORDER BY r.key) FROM slab_evidence_refreshes r), '[]'::jsonb),
  'revisions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'key', v.key, 'payload', v.payload, 'bytes', v.byte_count, 'observations', v.observation_count,
      'retained', v.retained, 'supply', v.supply_scan_id IS NOT NULL) ORDER BY v.key, v.payload::text)
    FROM slab_evidence_revisions v), '[]'::jsonb),
  'scans', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', s.id::text, 'source', s.source_key, 'provider', s.provider, 'group', s.valuation_group_key,
      'asset', s.asset_id, 'captured', to_char(s.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'complete', s.complete, 'reported', s.reported_count, 'stored', s.stored_count, 'content', s.content_hash)
      ORDER BY s.captured_at, s.id) FROM slab_supply_scans s), '[]'::jsonb),
  'versions', COALESCE((SELECT jsonb_agg(jsonb_build_object('hash', x.hash, 'listing', x.listing_key, 'payload', x.payload)
      ORDER BY x.hash) FROM slab_supply_versions x), '[]'::jsonb),
  'observations', COALESCE((SELECT jsonb_agg(jsonb_build_object('scan', o.scan_id::text, 'listing', o.listing_key,
      'version', o.version_hash, 'position', o.position) ORDER BY o.scan_id, o.position) FROM slab_supply_observations o), '[]'::jsonb)
) AS captured
