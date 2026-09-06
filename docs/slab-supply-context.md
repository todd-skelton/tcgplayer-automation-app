# Slab supply context

The slab review page can explicitly refresh active Alt and eBay Research listings. Opening saved supply performs no provider requests. Supply is context only: asks never adjust a recommendation or establish a floor or ceiling. This delivers the observation foundation of #30; it does not enable a sell-through model.

Confirm the certificate, open **Supply context**, and refresh. Imported seller item IDs are excluded, including known eBay links in Alt results. Import missing seller inventory before treating the remaining listings as competitors. Equivalent identity matches, potential matches and excluded listings are separate. Auction bids, unknown price kinds, bundles, contradictions, inactive listings and snapshots older than 15 minutes do not count as competition. Delivered asks require known item price and shipping in USD. Listing age is age since the reported start, not time exposed at the current price.

Alt responses are bounded to 2,000 normalized observations / 1 MiB. The page returns 50 rows at a time. eBay search pages are fetched explicitly, remain separate observation scopes, and are not an exhaustive market inventory. Refresh returns to the first source page. Polling runs only while an explicitly requested job is queued/running; reload, cancellation and reconnect reuse the evidence workflow.

Migration 030 stores immutable supply scans and listing versions in PostgreSQL. An unchanged scan copies small version references; only changed listing bodies create new versions. New evidence revisions store metadata and a scan reference, and the existing read boundary reconstructs listings in source order. Legacy inline revisions remain readable. Capture shares the evidence lease transaction, so cancelled/stale workers cannot append history. Retention keeps the latest 200 observations per source plus protected cache/recommendation references; bounded cleanup removes unreferenced scans older than 180 days and orphan versions. No new service or dependency is required.

Comparisons identify newly observed listings, absence from a partial scan, and observed price/availability/quantity/detail changes. None establish a sale or continuous exposure. The small seller-outcome contract distinguishes sales, linked cancellations and relists, rejects conflicting/future records and requires notes for manual evidence. It is tested offline but has no connected outcome adapter or outcome persistence yet. Seller OAuth, verified outcomes and time-separated exposure validation remain prerequisites for that part of #30.

## Evaluation and validation

The committed historical fixture contains 19 active observations across Krabby, Espathra and Slaking. It preserves uncertain listing formats, a years-old ask, an auction bid, known own listings and a lower-grade ask above a higher-grade ask. It is a single historical observation, so it cannot measure sale probability, time to sell, calibration or incremental pricing accuracy. These metrics remain unavailable; no supply adjustment is adopted.

Local native-session validation on September 6, 2026 UTC captured the Hitmonlee research scope twice about eight minutes apart. Alt returned zero active listings; eBay returned three potential matches with a lowest known delivered ask of USD 105.39. The target identity remained unconfirmed. No listing changes were observed. The two eBay scans stored six small references to three listing bodies, and both sources' cache revisions used scan references. This short diagnostic does not demonstrate sell-through.

Reproduce offline behavior with `npm test`. With the guarded local development PostgreSQL database at localhost:5433/tcgplayer_automation, run:

```sh
npx tsx app/features/ebay-slab-pricing/supply/supplyObservations.integration.test.ts
npx tsx app/features/ebay-slab-pricing/research/slabResearch.integration.test.ts
npx tsx app/features/ebay-slab-pricing/evidence/evidenceRefresh.integration.test.ts
```

The disposable-schema integration test checks immutable/idempotent scans, changed-price versions, source order, reference-only evidence storage, retention of protected revisions and cancellation fencing. A 203-scan / 50-listing stress case leaves 200 recent scans plus one retained scan, 10,050 references and 51 listing bodies after one price change. Workspace checks reject another grade's source page and preserve the 50 known seller IDs without remote fetches. The existing recommendation and comp-decision integration suites also run with migration 030.

For recovery, reconnect the failed evidence source and explicitly refresh. A failed/stale snapshot stays visible with counts excluded. Apply migration 030 before running this build; keep migrations 027/030 and their referenced data together when restoring a database backup. No publication or scheduler is enabled by this migration.
