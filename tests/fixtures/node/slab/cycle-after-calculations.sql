-- After the recorded cycles' recommendations are calculated (scripts/parity/slab-cycle.ts): the
-- recommendation of MAINTENANCE-2 is given a reviewed price, so maintenance holds it.
INSERT INTO slab_price_overrides (recommendation_id, item_price, currency, note)
SELECT r.id, 125, 'USD', 'Preserve the reviewed price'
FROM slab_recommendations r JOIN slab_identities d ON d.id = r.slab_id
WHERE d.certificate_number = 'MAINTENANCE-2';
