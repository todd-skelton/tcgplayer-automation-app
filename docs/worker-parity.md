# Worker parity

Each Rust worker is proven against Node's by a twin run: `scripts/parity/twin.mjs` copies the dev
database once per worker, runs Node's worker on one copy and the Rust worker on the other from the
same state, then compares every row either wrote. Neither publishes: Seller Portal writes stay off,
and only the worker under test is started. Times, and anything named by one, are skipped. A worker
that reads TCGplayer reads it twice, minutes apart, so in a live run a number that differs is counted
as moved with the market, as is a listing's in stock flag where its quantity moved; everything else
must be equal.

Every other worker is held off by a blank switch, since a missing one would be read from dev's
env files, which turn them all on. Before 2026-11-05 the twins removed the switches instead, so the
Rust copy also ran the other workers; the order history sync it ran beside the pricing twin showed
in that twin's written tables, and nothing it wrote was compared.

Run one with a fresh `cargo build` and no other sessions on the dev database.

Rows are matched by what names them where ids are assigned in an order set by timing: orders by
order number, their lines and FIFO lines by SKU id, revisions by revision number.

| Worker | Script | Last run | Result |
| --- | --- | --- | --- |
| Batch pricing, cached job | `twin-pricing-worker.mjs 7122 cached` | 2026-11-07, dev at Corten f3291094 | 50 SKUs and a 31-item planned publication; 27,729 values, 0 differ (earlier the same day at Corten cdbe4392: 27,729 values, 0 differ; 2026-11-06 at Corten a8c50d41: 27,729 values, 0 differ; 2026-11-05 with batch 3516 on the production copy: 8,735 values, 0 differ; 2026-11-04 on old dev data: 20,706, 0 differ) |
| Batch pricing, full job | `twin-pricing-worker.mjs 3471 full` | 2026-11-07, dev at Corten f3291094 | live TCGplayer reads: both completed, same rows in every table compared (5 results, 4 curves, 4 publication items, 14 listing snapshots); 2,532 values that are not market numbers, 0 differ; the rest moved with the market (2026-11-03: same tables, rows and 17 listing snapshots; numbers moved with the market only) |
| Continuous pricing scheduler | `twin-continuous-scheduler.mjs` | 2026-11-07, dev at Corten f3291094 | one live refresh and two batches each (54 batch items); 62,651 values, 0 differ; three listings' quantity and in stock and the refresh's observed count moved with the market (2026-11-06 at Corten a8c50d41: one refresh of 3,089 listings and one 50-SKU batch, 62,391 values, 0 differ; 2026-11-05 on the production copy: 62,391 values, 0 differ) |
| Seller order history (sync, FIFO replay, cost estimates) | `twin-seller-order-history.mjs` | 2026-11-06, dev at Corten a8c50d41 | sync complete on both (1,624 orders); 9 tables, 624,295 values, 0 differ (earlier the same day at Corten a17f1775: 624,066 values, 0 differ; 2026-11-05 on the production copy: 1,631 orders, 620,052 values, 0 differ) |
| Slab evidence and maintenance | no twin: neither dev nor production holds slab data (checked on the 2026-11-05 copy) | | see below |
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

The two dev shadows, run on 2026-11-06 at Corten 94cea042: the FIFO replay matches Node's saved
lines on all 2,971 SKUs. The batch pricing replay of jobs 7103 to 7112 (a diagnostic, not a gate;
see `batch_pricing::shadow`) found 102 SKUs priced from competing asks, 2 Node could not reach
TCGplayer for and 2 that differ: a warning that names a delivered listing Node read and the ledger
does not hold (the same price), and one SKU with capped sales history priced at $21.13 from the
ledger against Node's $20.83, no supply read. Neither is a Corten matter.

## Dev cutover

Workers move to Rust in dev one at a time; production keeps Node's until Todd approves a deploy.

| Worker | Dev owner | Switch |
| --- | --- | --- |
| Batch pricing | Corten app | `PRICING_WORKER=1` in `.env.development.local`; Node's `ensureInventoryBatchPricingWorker` reads it and stays off |
| Continuous pricing scheduler | Corten app | `CONTINUOUS_PRICING_SCHEDULER=1` in `.env.development.local`; Node's scheduler (`app/workers/continuous-pricing-scheduler.server.ts`, which `npm run dev` does not start) exits at once when it sees it |
| Seller order history | Corten app | `SELLER_ORDER_HISTORY_WORKER=1` in `.env.development.local`; `npm run dev` and the container start scripts then leave Node's worker out (a supervised child that exits stops the dev server with it), and the worker itself (`app/workers/seller-order-history-worker.server.ts`, also `npm run start:seller-order-history-worker`) exits at once when it sees it |
| Slab evidence and maintenance | Corten app | `SLAB_EVIDENCE_WORKER=1` in `.env.development.local`; Node's in-process start (`ensureEvidenceWorker`) stays off and its standalone worker (`npm run start:slab-evidence-worker`, which `npm run dev` does not start) exits at once when it sees it |
| Inventory publication | Corten app | `PUBLICATION_WORKER=1` in `.env.development.local`; Node's in-process start (`ensureInventoryPublicationWorker`) stays off and its standalone worker exits at once. Dev never sets `SELLER_PORTAL_WRITES_ENABLED`, so the Rust worker reports itself off and claims nothing, as Node's did: a planned publication stays planned |

The Rust scheduler's first dev run, from `.env.development.local` alone: it refreshed the seller's inventory and queued batch 3771 (job 3704) and, once the worker claimed that, batch 3772 (job 3705), 50 SKUs each in full mode. The Rust worker priced job 3704 in 30 m 34 s, 50 of 50 results successful, and the pricing planned continuous publication 8217 with 41 items, left planned since dev publishes nothing. Node's recent full continuous jobs of 36 SKUs took 23 to 34 minutes. The run was stopped with job 3705 claimed; after its claim expired the next worker reclaimed it (attempt 2) and completed it at 16:57 UTC, about 30 minutes after that worker started (the job keeps its first attempt's `started_at`, so its recorded 48 m includes the stop), 50 of 50 successful, planning publication 8218 with 43 items. Node's scheduler entry, started with the switch set, printed that it was off and exited.

The Rust seller order history worker's first dev run, from `.env.development.local` alone with the pricing worker and scheduler off: the last sync in dev had been Node's run 2380 on 2026-10-30. Run 2439 read the 1,634 orders in five pages and 80 details in 53 s with no gaps and finished complete. Across that run and the cycles after it, the worker replayed 152 queued FIFO SKUs (25 a cycle at most) until the queue was empty, and recorded the estimated purchase cost of batch 2733. Node's worker, started with the switch set, printed that it was off and exited.

With `SLAB_EVIDENCE_WORKER` and `PUBLICATION_WORKER` set (Corten 62f3199f), the server logged "Slab evidence worker started" and "Inventory publication worker is off: PUBLICATION_WORKER is set but SELLER_PORTAL_WRITES_ENABLED is not true", and nothing on stderr after it; the dev database holds no slab data, so the slab worker had nothing to claim. Node's two standalone workers, started with their switches set, each printed that it was off and exited.

Batch pricing's first dev jobs under the Rust worker, queued from the port's Batch Pricer: job 3702 (batch 3516, cached, 36 SKUs) in 0.6 s, and job 3703 (batch 2730, full, 16 SKUs, live TCGplayer reads) in 6 m 13 s, 16 processed, 0 errors, 2 warnings, as Node's last full job of that batch (2735) had.
