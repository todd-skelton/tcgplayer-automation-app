# Opt-in slab evidence maintenance

Open a seller's saved inventory, then **Evidence maintenance**. Enable it explicitly, choose whether to collect active supply, and save. Migration 033 defaults every seller to paused. The panel is loaded on demand; the existing slab evidence worker handles maintenance when its evidence queue has no ready work. No new service or dependency is introduced, and TCGplayer pricing/publication workers are unchanged.

Each cycle checks at most 25 listings and requests at most 50 source jobs. Defaults are 10 listings, 20 requests and a six-hour interval. Confirmed, active, single-quantity fixed-price inventory is eligible for collection; variations, contradictory identities and unresolved listing warnings stay in review. Shared evidence keys coalesce across listings. Existing cache freshness, provider cooldowns, retry limits and job priority apply. Missing, unchecked or expired-auth connections pause that source while other sources can progress. Opening paused maintenance makes no provider requests.

The worker checks for due groups every 30 seconds. A listing's next ordinary check follows its configured 15–1,440 minute interval. New/changed inventory or identities take priority; changed settings and newly saved recommendations become eligible immediately. Queued evidence and work deferred by the request budget are checked again after 30 seconds. A rolling 365-day Chicago-date window matches the review page default. Selected sales sources/pages are retained from the previous recommendation with their windows advanced; optional supply is collected separately and never becomes sold evidence.

Recalculation requires a first manually saved recommendation, which supplies the seller's costs, fees, policy and constraints. Maintenance uses the current imported ask and shipping charge and fresh selected evidence. Identical inputs do not create another recommendation. A reviewed price override is held, including when review races a background calculation: both serialize on the slab identity, and a superseded review must be reloaded before saving. Insufficient evidence continues to require review. Maintenance does not import seller inventory or publish prices; automatic publication remains unavailable without a connected live publisher and adopted cohorts.

Settings and listing checkpoints persist in PostgreSQL. Revision checks prevent stale settings saves, and 90-second leases fence competing workers and stale checkpoints. Pause stops new work from subsequent checks; already queued shared evidence and an in-progress calculation may finish. Restarting the optional standalone slab evidence worker resumes saved enabled settings. In-process mode resumes when the maintenance panel or an evidence workflow starts the existing worker; it requires a running app process. With `WORKERS_RUN_IN_PROCESS=false`, start `npm run start:slab-evidence-worker` after building. The panel reports that requirement rather than claiming a worker heartbeat.

Apply migration 033 before starting this build. Back up/restore its settings and checkpoints with the referenced inventory, identity, recommendation and evidence tables. Pause maintenance before an application rollback. Leave the additive tables intact; older builds do not execute this scheduler. After restoring a backup, keep maintenance paused until connections, inventory and evidence are checked. Do not automatically replay an unresolved publication: its recorded write boundary still requires independent reconciliation.

## Validation

Run `npm test`, `npm run typecheck`, `npm run build`, and:

```sh
npx tsx app/features/ebay-slab-pricing/maintenance/slabMaintenance.integration.test.ts
npx tsx app/features/ebay-slab-pricing/valuation/slabRecommendations.integration.test.ts
npx tsx app/features/ebay-slab-pricing/research/slabResearch.integration.test.ts
```

The guarded local PostgreSQL maintenance test creates and removes a disposable schema. It verifies six distinct certificates sharing one source job, request budgets, fresh recalculation, unchanged warm cycles, concurrent manual-review protection, unavailable-source isolation, competing/expired leases, pause fencing and zero publication/provider calls. A 5,000-listing unconfirmed fixture stays bounded to 25 checks per cycle: five local samples on September 6, 2026 measured p50 221.8 ms and maximum 318.0 ms. These are database-only development measurements, not provider latency or production contention results.

Local browser validation imported a clearly labeled synthetic listing, verified paused defaults, enabled a one-listing cycle, observed the identity-required hold, then paused and removed the fixture. No provider request or live price write was made for it. This completes the evidence-maintenance portion of #32; seller import, verified model cohorts, live write budgets and end-to-end automation acceptance remain open.
