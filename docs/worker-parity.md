# Worker parity

Each Rust worker is proven against Node's by a twin run: `scripts/parity/twin.mjs` copies the dev
database once per worker, runs Node's worker on one copy and the Rust worker on the other from the
same state, then compares every row either wrote. Neither publishes: Seller Portal writes stay off,
and only the worker under test is started. Times, and anything named by one, are skipped. A worker
that reads TCGplayer reads it twice, minutes apart, so in a live run a number that differs is counted
as moved with the market; everything else must be equal.

Run one with a fresh `cargo build` and no other sessions on the dev database.

Rows are matched by what names them where ids are assigned in an order set by timing: orders by
order number, their lines and FIFO lines by SKU id, revisions by revision number.

| Worker | Script | Last run | Result |
| --- | --- | --- | --- |
| Batch pricing, cached job | `twin-pricing-worker.mjs 3516 cached` | 2026-11-04 | 20,706 values, 0 differ |
| Batch pricing, full job | `twin-pricing-worker.mjs 3471 full` | 2026-11-03 | same tables, rows and 17 listing snapshots; numbers moved with the market only |
| Continuous pricing scheduler | `twin-continuous-scheduler.mjs` | 2026-11-04 | one live refresh (802 listings) and one 50-SKU batch each; 56,471 values, 0 differ |
| Seller order history (sync, FIFO replay, cost estimates) | `twin-seller-order-history.mjs` | 2026-11-04 | sync complete on both (1,640 orders, 78 details read); 13 tables, 533,113 values, 0 differ |
| Slab evidence and maintenance | no twin: the dev database holds no slab data | | see below |
| Inventory publication | no twin: it posts to Seller Portal | | see below |

Where a twin cannot run, Node's code is recorded instead, against the same committed provider
fixtures or dev batches the Rust tests replay:

1. `scripts/parity/slab-parsers.ts`: Node's Alt and eBay Research readers over the provider
   fixtures and 34 edge cases (`tests/fixtures/node/slab/*-parse.json`), checked in every gate.
2. `scripts/parity/slab-evidence.mjs`: Node's evidence queue, worker job (a stand-in fetch) and
   supply scans on a schema-only database (`tests/fixtures/node/slab`).
3. `scripts/parity/publish-selections.mjs`: Node's publication planning of ten dev cases, each on a
   fresh copy of the dev database (`tests/fixtures/node/publication`).
4. `scripts/parity/pubworker.mjs`: Node's publication worker, a turn at a time, over 18 cases, each
   on a fresh copy of the dev database seeded with its own seller, received batch and live
   inventory (`pubworker-seed.sql`). Seller Portal's client is stood in with scripted answers, so
   nothing is posted and its writes stay off. The cases cover a received batch planned from its
   intake run and made live, every move-to-live outcome, a refused, challenged or unreachable
   sign-in, failed uploads, finalizes and moves with their rollbacks, lost workers' publications,
   intake runs left for review, a direct publication, and paused publishing.

5. `scripts/parity/slab-cycle.mjs`: Node's slab maintenance cycle at a fixed time on a schema-only
   database. Node's identity, inventory and evidence functions build a seller's listings (confirmed
   slabs in USD and CAD, one listed two at a time, unconfirmed and ended ones, Alt sales evidence),
   dumped with fixed times to `tests/fixtures/node/slab/cycle-seed.sql`. Recommendations are
   calculated and one reviewed, then four cycles run: the first, every listing due again, the
   evidence expired, and no seller due.

Every worker now has its Node recording committed; no test reads the uncommitted `.port-logs`.
The recordings' Rust tests are `#[ignore]` only because they use the dev database, in a
transaction rolled back.

## Dev cutover

Workers move to Rust in dev one at a time; production keeps Node's until Todd approves a deploy.

| Worker | Dev owner | Switch |
| --- | --- | --- |
| Batch pricing | Corten app | `PRICING_WORKER=1` in `.env.development.local`; Node's `ensureInventoryBatchPricingWorker` reads it and stays off |
| Continuous pricing scheduler | Corten app | `CONTINUOUS_PRICING_SCHEDULER=1` in `.env.development.local`; Node's scheduler (`app/workers/continuous-pricing-scheduler.server.ts`, which `npm run dev` does not start) exits at once when it sees it |
| Seller order history, slab evidence, inventory publication | Node | unchanged |

The Rust scheduler's first dev run, from `.env.development.local` alone: it refreshed the seller's inventory and queued batch 3771 (job 3704) and, once the worker claimed that, batch 3772 (job 3705), 50 SKUs each in full mode. The Rust worker priced job 3704 in 30 m 34 s, 50 of 50 results successful, and the pricing planned continuous publication 8217 with 41 items, left planned since dev publishes nothing. Node's recent full continuous jobs of 36 SKUs took 23 to 34 minutes. The run was stopped with job 3705 claimed; after its claim expired the next worker reclaimed it (attempt 2) and completed it at 16:57 UTC, about 30 minutes after that worker started (the job keeps its first attempt's `started_at`, so its recorded 48 m includes the stop), 50 of 50 successful, planning publication 8218 with 43 items. Node's scheduler entry, started with the switch set, printed that it was off and exited.

Batch pricing's first dev jobs under the Rust worker, queued from the port's Batch Pricer: job 3702 (batch 3516, cached, 36 SKUs) in 0.6 s, and job 3703 (batch 2730, full, 16 SKUs, live TCGplayer reads) in 6 m 13 s, 16 processed, 0 errors, 2 warnings, as Node's last full job of that batch (2735) had.
