# Reviewed seller outcomes

Open saved eBay inventory, then **Seller outcomes**. This provides a manual fallback while the seller order adapter is unavailable. Enter a listing's item ID to read its saved observations, or expand **Import reviewed outcomes** and paste a CSV. Original item IDs must already exist in that seller's inventory; ended/sold listings can be imported as historical inventory first. A relist's next item ID can be recorded before its inventory is imported.

Imports accept 1–50 rows / 256 KiB and preserve exact text identifiers. Required columns are `event_id,item_id,kind,occurred_at,quantity,note`. Use a stable receipt/order-line event ID (letters, digits, underscore, dot, colon or hyphen), a UTC timestamp, quantity 1 and a note identifying the reviewed evidence. Optional sale fields are `price,currency`; this is the item sale price, not shipping, tax, buyer premium or net proceeds. Unknown amounts remain blank. A cancellation requires `related_sale_id`; a relist requires `next_item_id`. Cancellation/relist price fields stay blank. For example, with your actual imported item IDs and evidence:

```csv
event_id,item_id,kind,occurred_at,quantity,note,price,currency,related_sale_id,next_item_id
sale-example,900000000001,sale,2026-09-01T12:00:00Z,1,Replace with the reviewed receipt reference,125,USD,,
cancel-example,900000000001,cancellation,2026-09-02T12:00:00Z,1,Replace with the cancellation evidence,,,sale-example,
relist-example,900000000001,relist,2026-09-03T12:00:00Z,1,Replace with the relisting evidence,,,,900000000002
```

Migration 034 stores immutable normalized observations in one feature-owned table. Identical repeated or concurrent imports insert only once and retain the first server-recorded observation time. CSV fields cannot claim eBay-provider provenance or backdate when the application learned about an event. This supports later time-separated evaluation without treating an old sale entered today as historical knowledge available yesterday.

Different claims for the same event ID remain in the audit and are held as unresolved; a later import does not silently replace history. This also works when a claim changes the item ID. Conflicting or invalid linked cancellations hold affected sales instead of silently making them usable again. Notes can be supplemented by repeating a claim with a different note, but contradictory event facts need a separate audit and are not automatically resolved by choosing the newest row. Reuse stable event IDs to avoid entering the same sale as two events; automatic cross-source order deduplication is still pending the native order adapter.

Review loads only one listing's event groups, up to 250 observations. Larger histories abstain for separate audit instead of reporting truncated totals. Counts describe the saved records: they are not a complete order history or seller-volume measurement. Price, inventory quantity/state, market comps and recommendations are untouched. Listing disappearance never creates a sale. No sale probability, time-to-sell model or automatic publication is enabled by this data.

The CSV parser is a separate adapter over the normalized seller-outcome contract; PostgreSQL owns storage and the existing pure reconciler owns cancellations/conflicts. The panel is lazy-loaded and reads saved data without polling or provider requests. No package, service or background job was added. Observations are retained for provenance; there is no automatic audit purge. Include this table with the seller inventory account in full database backups. Older app builds can leave the additive table intact on rollback.

## Validation

`npm test` covers parser bounds, exact IDs, invalid chronology, immutable source attribution and conflicting cancellations. With the guarded local development PostgreSQL database, run:

```sh
npx tsx app/features/ebay-slab-pricing/supply/sellerOutcomes.integration.test.ts
node app/features/ebay-slab-pricing/evaluation/verify-slab-recovery.mjs
```

The disposable-schema integration checks concurrent duplicate imports, first observation time and historical cutoffs, cancellation/relist reconciliation, changed-item conflicts, seller isolation, atomic rejection of invalid batches, same-origin/method gates, unchanged inventory and zero remote calls. A 250-observation append fixture completed in 373.7 ms locally; a review beyond 250 observations correctly abstained. These are synthetic data/storage checks, not verified seller outcomes or production performance. The backup rehearsal includes this table and now applies 34 migrations across 44 restored tables.

This completes the manual outcome collection portion of #30. Native seller order reads, cross-source verification, longitudinal exposure and time-separated calibration remain outstanding. The current supply and grade policies remain unadjusted until that evidence supports adoption.

Local browser verification imported a synthetic sale, showed one usable sale record, imported its linked cancellation, and showed zero remaining sale records with the recorded source/time/link visible. The listing remained active at USD 100. The fixture and its two observations were removed afterward. The host production build's lazy outcome panel is 1,984 gzip bytes excluding shared imports. Existing TCGplayer worker byte sizes are unchanged, and existing pricing routes load no slab implementation chunks; their cumulative navigation/manifest growth remains below the measured 4 KiB gate. These static checks compare the current Node 24 host build against the retained Node 20 pre-slab baseline, not a new runtime-latency comparison.
