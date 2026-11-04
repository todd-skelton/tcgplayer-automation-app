-- What the recorded slab maintenance cycles saved (scripts/parity/slab-cycle.ts and
-- slab_pricing::maintenance_cycle's cycles_run_as_node_runs_them). Recommendation ids are random, so
-- each is named by its slab's certificate and whether it is that slab's latest; clock times are read
-- as whether they are set or how they relate.
WITH latest AS (
  SELECT DISTINCT ON (r.slab_id) r.slab_id, r.id FROM slab_recommendations r ORDER BY r.slab_id, r.created_at DESC, r.id DESC
)
SELECT json_build_object(
  'settings', (SELECT json_agg(json_build_object('seller', seller, 'enabled', enabled, 'revision', revision,
      'leased', lease_id IS NOT NULL, 'cycled', last_cycle_at IS NOT NULL, 'error', last_error,
      'summary', last_summary, 'dueSoon', next_cycle_at <= clock_timestamp() + interval '30 seconds')
    ORDER BY seller) FROM slab_maintenance_settings),
  'items', (SELECT coalesce(json_agg(json_build_object('item', i.item_id, 'inventoryRevision', m.inventory_revision,
      'identityRevision', m.identity_revision, 'inputKey', m.input_key, 'outcome', m.outcome, 'reason', m.reason,
      'recommendationIsLatest', m.recommendation_id IS NOT DISTINCT FROM latest.id,
      'recommendation', m.recommendation_id IS NOT NULL, 'settingsRevision', m.settings_revision,
      'checkIn', CASE WHEN m.next_check_at - m.checked_at < interval '1 minute' THEN 'soon' ELSE 'interval' END)
    ORDER BY i.item_id), '[]')
    FROM slab_maintenance_items m JOIN slab_inventory i ON i.id = m.inventory_id LEFT JOIN latest ON latest.slab_id = i.identity_id),
  'recommendations', (SELECT coalesce(json_agg(json_build_object('certificate', d.certificate_number,
      'latest', r.id = latest.id, 'identityRevision', r.identity_revision, 'calculation', r.calculation,
      'evidence', (SELECT json_agg(e.revision_id ORDER BY e.revision_id) FROM slab_recommendation_evidence e WHERE e.recommendation_id = r.id),
      'reviewed', EXISTS (SELECT 1 FROM slab_price_overrides o WHERE o.recommendation_id = r.id))
    ORDER BY d.certificate_number, r.created_at, r.calculation::text), '[]')
    FROM slab_recommendations r JOIN slab_identities d ON d.id = r.slab_id JOIN latest ON latest.slab_id = r.slab_id),
  'refreshes', (SELECT coalesce(json_agg(json_build_object('key', key, 'spec', spec, 'state', state, 'priority', priority,
      'attempts', attempts, 'latestRevision', latest_revision, 'fresh', expires_at > clock_timestamp(), 'error', error_code)
    ORDER BY key), '[]') FROM slab_evidence_refreshes),
  'retained', (SELECT coalesce(json_agg(id ORDER BY id), '[]') FROM slab_evidence_revisions WHERE retained),
  'publications', (SELECT count(*) FROM slab_publications)
)
