# Production cutover plan

A plan for Todd's review. Nothing here has been run against production: every step that touches
the `tcgplayer-automation-prod` stack, its database or `origin/master` waits for his approval,
one release at a time.

## Where production is

Read from the repository, not the running containers:

1. Production runs `origin/master` (942bde0d1 when this was written): the proxy on port 3001 in
   front of the Node app's blue or green slot, and the Node workers `pricing-worker`,
   `publication-worker`, `slab-evidence-worker` and `pricing-scheduler`, each its own
   container with `restart: unless-stopped`.
2. Node's seller order history worker has no container of its own: the Node app's container
   starts it beside the app (`scripts/docker-start.mjs`).
3. `codex/corten-port` is 298 commits ahead of master. Its `docker-compose.prod.yml` puts the
   Corten app (`web-blue`, `web-green`) in front of each Node slot; the proxy sends traffic to
   it, and it relays what it has not ported (the JSON routes in `docs/node-route-retirement.md`)
   to its slot's Node app.
4. The branch adds three migrations, 053 to 055 (two tables and an index). Each is marked
   `-- online:`, so `scripts/releasePlan.mjs` plans an overlap release: the running slot keeps
   serving while the new one migrates (checked: `planRelease` returns `overlap`).

## Releases

Each is a separate release through `npm run prod:update`, which requires `HEAD` to equal
`origin/master`. One job moves per release, so a problem has one cause. Each needs Todd's
approval before it starts.

| Release | Change | Switch in `.env.production.local` | Node removed in the same release |
| --- | --- | --- | --- |
| 1 | Corten serves every screen; every job stays on Node | none | nothing |
| 2 | Seller order history, FIFO replay, cost estimates | `SELLER_ORDER_HISTORY_WORKER=1` | the start scripts leave Node's worker out when the switch is set |
| 3 | Batch pricing | `PRICING_WORKER=1` | `pricing-worker` service |
| 4 | Continuous pricing schedule | `CONTINUOUS_PRICING_SCHEDULER=1` | `pricing-scheduler` service |
| 5 | Slab evidence and maintenance | `SLAB_EVIDENCE_WORKER=1` | `slab-evidence-worker` service |
| 6 | Publication to Seller Portal | `PUBLICATION_WORKER=1` | `publication-worker` service |
| 7 | Migrations | `MIGRATE_ON_START=1` | the migration run in `scripts/docker-start.mjs` |
| 8 | The Node app, its relay and `LEGACY_ORIGIN` | none | `app-blue`, `app-green` |

Why this order: order history only reads TCGplayer and writes its own tables, and dev has run it
in Rust since 2026-11-04. Pricing and the schedule plan publications but do not post them.
Publication posts to the live store, so it moves after every job that feeds it has run clean.
Migrations move last because the two runners share no lock (`src/migrations.rs`).

A Node service is removed rather than left to see the switch. Node's standalone pricing worker
does not read `PRICING_WORKER`, so both workers would claim from the same queue. The scheduler
and order history workers exit when they see their switch, and with `restart: unless-stopped`
Docker would restart them in a loop.

## Before release 1

1. Merge `codex/corten-port` into master through a pull request. This is a publish step and
   needs approval.
2. Build the `web` image target from the merged commit under a tag other than `:prod`, so a
   failed Rust build is found before the release. The release builds both images first and
   changes nothing if a build fails, so this only saves time. Done on 2026-11-04 from 5bc12b1d7
   (Corten 62f3199f): the release build took 15 m 34 s in Docker, the image is 117 MB, and run
   against the dev database with no switches it started every worker off and answered 200 on all
   16 screens and `/health/ready`. Repeat it from the merged commit.
3. Optional, and it reads production: refresh the dev database from production
   (`npm run dev:db:refresh`) and run the gate and the twin scripts against that copy.

## Checks after each release

1. `http://localhost:3001/proxy-health` names the new slot color, and `npm run prod:status` shows
   every container healthy.
2. Release 1: each screen in the nav loads through port 3001; a relayed JSON route answers from
   Node (`GET /api/inventory/product-lines`, a read); the batch pricer's pricing stream delivers events
   through the proxy (`proxy_buffering off`).
3. Releases 2 to 6: the worker's start line in the `web` container's log, then its first cycle.
   Order history: a `seller_order_sync_runs` row reaches `complete`. Pricing: the next queued
   job completes with Node's error counts for the same SKUs. Schedule: the next continuous batch
   is queued at its interval. Slab: the next maintenance cycle records a summary. Publication: the
   next publication reaches `published` with no ambiguous items, watched as it posts.
4. No job runs twice: the Node service for it is gone from `npm run prod:status`.

## Rolling back

1. A release whose new slot never becomes healthy is stopped by the release script, and the old
   slot keeps serving.
2. After a switch: unset it, restore the Node service, and release again. Claims expire on their
   own, so a job the Rust worker held is taken up again by Node's (seen in dev: job 3705 was
   reclaimed on its second attempt).
3. Release 1: revert the merge on master and release. Migrations 053 to 055 stay; Node's code
   ignores the two tables and the index.

In dev, every job now runs in the Corten app (`docs/worker-parity.md`, Dev cutover); the
publication worker is switched there but stays off without Seller Portal writes, so release 6 is
its first run that posts.

## Open for Todd

1. Approval to merge `codex/corten-port` into master, and for release 1.
2. Whether to refresh dev from production first (step 3 before release 1).
3. How long each worker should run in production before the next release. The suggestion is one
   full day of normal use, since the schedule and order history run hourly.
