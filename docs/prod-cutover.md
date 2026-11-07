# Production cutover plan

The plan for moving production to the Corten app. Release 1 ran on 2026-11-05 and release 2 on
2026-11-07 (sections below);
every later step that touches the `tcgplayer-automation-prod` stack, its database or
`origin/master` waits for Todd's approval, one release at a time.

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
| 7 | Migrations | `MIGRATE_ON_START=1` | the start script skips Node's migration run when the switch is set |
| 8 | The Node app, its relay and `LEGACY_ORIGIN` | none | `app-blue`, `app-green` |

Why this order: order history only reads TCGplayer and writes its own tables, and dev has run it
in Rust since 2026-11-04. Pricing and the schedule plan publications but do not post them.
Publication posts to the live store, so it moves after every job that feeds it has run clean.
Migrations move last so that every earlier release keeps the runner it was proven with. The two
runners hold the same advisory lock (`src/migrations.rs`, `scripts/db-migrate.mjs`), so one never
applies a migration while the other does.

A Node service is removed rather than left to see the switch. Node's standalone pricing worker
does not read `PRICING_WORKER`, so both workers would claim from the same queue. The scheduler
and order history workers exit when they see their switch, and with `restart: unless-stopped`
Docker would restart them in a loop. The release script acts on the switches in
`.env.production.local` (`scripts/nodeWorkers.mjs`): after traffic moves it starts the Node worker
services whose switch is unset and removes those whose switch is set. Order history has no service
of its own; the Node app's start script leaves its worker out (`scripts/docker-start-support.mjs`).

## Before release 1

1. Merge `codex/corten-port` into master through a pull request. This is a publish step and
   needs approval.
2. Build the `web` image target from the merged commit under a tag other than `:prod`, so a
   failed Rust build is found before the release. The release builds both images first and
   changes nothing if a build fails, so this only saves time. Done on 2026-11-04 from 5bc12b1d7
   (Corten 62f3199f): the release build took 15 m 34 s in Docker, the image is 117 MB, and run
   against the dev database with no switches it started every worker off and answered 200 on all
   16 screens and `/health/ready`. Again on 2026-11-05 from 419423c17 (Corten 03c89942): 12 m 49 s,
   117 MB, run against the refreshed dev database below with no switches: every worker off, 200 on all
   16 screens and `/health/ready`. Repeat it from the merged commit.
3. Refresh the dev database from production (`npm run dev:db:refresh`) and run the gate and the
   twin scripts against that copy. Done on 2026-11-05: production's data restored onto migrations
   001 to 055 with no error. On that copy:
   1. Every twin with a script ran clean (`docs/worker-parity.md`).
   2. The JSON routes' answers, recorded again from Node on the copy, match Corten's: 15 of 15.
   3. Pricing on the same evidence (batch 3471) and a cached run (batch 3516), recorded again from
      Node: 10,498 values exact, 0 different; 15 of 15 SKUs priced alike.
   4. 11 screens, the batch pricer with batches of 150 and 263 items and the latest continuous
      batch, and the pack step load with no axe finding and no script error.
   The other ignored tests compare against recordings made on the earlier dev data (publication
   cases, the shadows, the strategy) or ask a running Node app, so they were not run on the copy;
   that data is kept in `.artifacts/db-backups/2026-11-05T03-15-59-363Z-db-before-refresh.dump`.
   Repeat the refresh only if production changes shape before the release.

## The proxy

`deploy/nginx/app.conf` against Corten's list of what a proxy must do (`docs/guide/deploy.md` at
Corten a0215cc9):

1. It passes `Host` as the browser sent it, sets `X-Forwarded-For` (the `web` containers list
   the compose network in `PROXIES`), turns buffering off for event streams, keeps the app's
   error bodies, and allows 50 MB uploads.
2. The `web` containers' health check reads `/health/ready`, which also checks the database,
   rather than `/`.
3. It reuses no upstream connection: `proxy_pass` names a variable and there is no `upstream`
   block. nginx 1.29.7 and later reuse them by default for 60 s, longer than the app's 30 s idle
   limit, so a move off `nginx:1.27-alpine` needs `keepalive_timeout` under 30 s.
4. It listens on plain HTTP, so a browser reaching port 3001 directly speaks HTTP/1.1, about six
   connections per host. A `<corten-live>` stream holds one while it is open: the batch panel's
   while a batch prices or publishes, and the configuration page's two report panels until they are
   read. Several tabs on those pages can queue other requests. Through Tailscale Serve, HTTPS ends
   before nginx; whether it speaks HTTP/2 to the browser was not checked. Serving HTTP/2 from
   nginx needs TLS there (a certificate for the name used).
5. Stopping a `web` container (the old slot after a switch, or `prod:down`) gives it Compose's
   `stop_grace_period: 30s`. Since Corten bd75e6ab a connection still answering is held to the
   deadline of its own request, not the app's longest, so a page whose client stopped reading
   ends at its page's deadline. A request of an area with a longer deadline that is still in
   progress (a catalog job in Data Management, up to an hour; a seller snapshot, up to 5 minutes)
   still ends with Docker's kill at 30 s, not a clean exit. Background tasks still get their 5 s
   grace first, and a killed catalog job leaves no lock behind and can be run again. Reported as
   [#887 Shutdown waits for every answering connection until the app's longest deadline, so one hour-long area makes a stalled page reader hold shutdown an hour and the guide's platform-wait rule unworkable](https://github.com/corten-run/corten/issues/887),
   fixed by [#914 Shutdown holds each connection to its own request's deadline, not the app's longest (#887)](https://github.com/corten-run/corten/pull/914).
6. The `web` containers answer only `localhost`, IP addresses and the names in `HOSTS`; any other
   `Host` gets 421. nginx passes the browser's `Host`, so if Tailscale Serve passes the tailnet
   name, the pages would answer 421 through it. `HOSTS` in `.env.production.local` (not committed)
   lists the machine's tailnet name. Writes are not affected by the proxy's plain HTTP: browsers
   send `Sec-Fetch-Site: same-origin`, which Corten accepts without comparing `Origin` to `Host`.

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
2. After a switch: unset it and release again; the release script starts the Node service again. Claims expire on their
   own, so a job the Rust worker held is taken up again by Node's (seen in dev: job 3705 was
   reclaimed on its second attempt).
3. Release 1: revert the merge on master and release. Migrations 053 to 055 stay; Node's code
   ignores the two tables and the index.

In dev, every job now runs in the Corten app (`docs/worker-parity.md`, Dev cutover); the
publication worker is switched there but stays off without Seller Portal writes, so release 6 is
its first run that posts.

## Release 1 (2026-11-05)

Merged as [#123 Corten port: every screen on the Corten app behind nginx (release 1)](https://github.com/todd-skelton/tcgplayer-automation-app/pull/123)
(0306b7879, Corten aaca3e05) and released with `npm run prod:update` from a clean master. A
second backup was taken just before: `.artifacts/db-backups/2026-11-05T15-54-48Z-prod-at-release-1.dump`.

1. Both images built, the blue slot (Node and Corten) started and migrated in overlap mode,
   nginx moved to `web-blue`, the Node workers were recreated on the new image, and green was
   removed. Migrations 053 to 055 are in place.
2. `/proxy-health` names blue and `npm run prod:status` shows every container healthy, with the
   four Node workers present. The `web` log shows every Rust worker and shadow off.
3. All 16 screens answer 200 through port 3001 and through Tailscale Serve. Through nginx the
   tailnet name is answered and an unlisted `Host` gets 421.
4. `GET /api/inventory/product-lines` is relayed: its answer is byte for byte what the Node app
   gives inside the network, and Corten has no route of its own for it.
5. The batch pricer's live stream for the latest batch answers `text/event-stream` through the
   proxy with its panel (`patch`) and `end`.
6. A write through Tailscale Serve in Chrome (a file that is not a pull sheet, on `/pull-sheet`)
   passed the same-origin check and came back 422 with the form's message; nothing was saved.
7. The `web` log has no error or panic; it has slow-statement warnings from the first loads of
   the strategy and economics screens on cold caches.

Release 2 can start after one full day of normal use, with Todd's approval.

## Release 2 (2026-11-07)

Todd approved it on 2026-11-07 after a day of shipping and inventory work on release 1 with no
issue. Merged as [#124 Corten port release 2: seller order history on the Corten worker](https://github.com/todd-skelton/tcgplayer-automation-app/pull/124)
(6a9f91066, 68 commits, Corten 9a1e0721) and released with `npm run prod:update` from a clean
master, with `SELLER_ORDER_HISTORY_WORKER=1` added to `.env.production.local`. A backup was taken
just before: `.artifacts/db-backups/2026-11-07T03-07-41Z-prod-before-release-2.dump` (`pg_restore -l`
lists 595 entries).

1. Before it, the order history twin on the release commit ran both syncs to `complete` with
   0 of 624,613 values different across 9 tables, and the release 1 `web` log had no error over
   the previous 6 hours.
2. The green slot took over, blue was removed and the Node workers were recreated.
   `/proxy-health` names green and every container is healthy with no restart.
3. The `web` log has "Seller order history worker started", then
   "complete offset=1624 total=1624". Its `seller_order_sync_runs` row (4182) reached
   `complete` at 03:15:25 UTC and `inventory_fifo_replay_queue` is empty.
4. The Node app's container runs only `docker-start.mjs` and its server; Node's order history
   worker is gone.
5. All 16 screens answer 200 through port 3001.
6. The `web` log has no error, panic or warning since the release.

Release 3 can start after one full day of normal use, with Todd's approval.

## Release 3 (2026-11-07)

Batch pricing moves to the Corten worker: `PRICING_WORKER=1` in `.env.production.local`, and the
release script removes Node's `pricing-worker` service. Todd approved it with releases 4 to 8 on
2026-11-07 (Decided, point 5). A backup was taken just before:
`.artifacts/db-backups/2026-11-07T14-17Z-prod-before-release-3.dump` (`pg_restore -l` lists 595
entries).

Production prices in batches all day: 453 full jobs completed from 2026-11-04 to 07:00 UTC on
2026-11-07 (about 155 a day, a mean of about 165 s each, the longest about 30 minutes), and one
failed on 2026-11-05. A job running when the switch moves is taken up again once its claim
expires.

Readiness:

1. The cached twin (`twin-pricing-worker.mjs 7122 cached`) at Corten f3291094: 50 SKUs and a
   31-item planned publication, 27,729 values, 0 differ.
2. The full twin (`twin-pricing-worker.mjs 3471 full`) at Corten f3291094, with live TCGplayer
   reads: both completed with the same rows in every table it compares (5 results, 4 curves, 4
   publication items, 14 listing snapshots); 2,532 values that are not market numbers, 0 differ.
3. The release script removes `pricing-worker` when the switch is set (`scripts/nodeWorkers.mjs`,
   its test in `npm test`).

Merged as [#125 Corten port release 3: batch pricing on the Corten worker](https://github.com/todd-skelton/tcgplayer-automation-app/pull/125)
(7ca435149, Corten 741b0a65) and released with `npm run prod:update` from a clean master, with
`PRICING_WORKER=1` added to `.env.production.local`.

1. The blue slot took over, green was removed, and the release removed `pricing-worker`; the other
   three Node workers were recreated. `/proxy-health` names blue and every container is healthy.
2. The `web` log has "Inventory batch pricing worker inventory-batch-worker-rust-1 started".
3. The next job the Node scheduler queued (7480, batch 7473, 11 SKUs, at 15:17 UTC) was claimed by
   `inventory-batch-worker-rust-1` and completed at 15:21:58 UTC: 11 of 11 rows processed, 0 errors,
   0 warnings, 0 skipped, as Node's jobs before it reported. Its continuous publication (6073) was
   posted by Node's publication worker and reached `published`.
4. All 16 screens answer 200 through port 3001 with no script error; the `web` log has no error,
   panic or warning.
5. Rollback: remove the switch and release again; the script starts `pricing-worker` again.

## Releases 4 to 7 (2026-11-07)

Each was released from the same master as release 3 (7ca435149, Corten 741b0a65) with
`npm run prod:update`, after adding one switch to `.env.production.local` and checking the release
before it. The images came from the build cache, so each took about a minute. Nothing was in flight
when releases 5, 6 and 7 started; a job a release interrupts is taken up again when its claim
expires (job 7481, below).

1. Release 4, the continuous pricing schedule (`CONTINUOUS_PRICING_SCHEDULER=1`, 15:24 UTC). Readiness:
   the scheduler twin at Corten f3291094 queued two batches on each side; 62,651 values, 0 differ
   (`docs/worker-parity.md`). The release removed `pricing-scheduler`, and the `web` log has
   "Continuous pricing scheduler started". Job 7481, which release 4's slot change interrupted, was
   reclaimed on its second attempt and completed (15 rows, 0 errors, 1 warning). When the next SKU
   came due (15:40:53 UTC) the Rust scheduler queued batch 7475 (15:41:04); the Rust pricing worker
   completed it with 0 errors and its publication (6075) was posted.
2. Release 5, slab evidence and maintenance (`SLAB_EVIDENCE_WORKER=1`, 15:43 UTC). Production holds no
   slab data (every `slab_` table empty and no provider connection), so the Rust worker has nothing
   to claim. Its proof is the recorded Node runs (`docs/worker-parity.md`). The release removed
   `slab-evidence-worker`, the `web` log has "Slab evidence worker started" and no error.
3. Release 6, publication to Seller Portal (`PUBLICATION_WORKER=1`, 15:46 UTC). The release removed
   `publication-worker`, the last Node worker service, and the `web` log has "Inventory publication
   worker inventory-publication-worker-rust-1 started". The next continuous batch (7478, 15 SKUs) ran
   the whole chain on the Corten app: queued by its scheduler, priced by its worker (15 rows,
   0 errors), and its publication (6076) posted by its publication worker on the first attempt,
   12 of 12 items `published` and none ambiguous.
4. Release 7, migrations (`MIGRATE_ON_START=1`, 15:56 UTC). The Node app's log has "Database migration
   skipped: MIGRATE_ON_START is set, so the Corten app applies them"; the Corten app, which exits
   before it serves if a migration fails, started and became healthy. No migration was pending:
   `schema_migrations` lists 57, the last 055. As Node's runner does, it logs only a migration it
   applies.

After release 7 every job runs in the Corten app: `npm run prod:status` lists only the proxy,
postgres and the blue slot's two containers, and `/proxy-health` names blue. The Node app still
serves the routes the relay sends it until release 8.

Observed: the Rust pricing worker logs "Pricing job heartbeat timed out after 2s" (and the progress
save) now and then, most often in the seconds after a job's final save, whose transaction holds the
job's row. Each job still completed on its first attempt; the lease is 15 s, so one missed beat does
not lose it.

## Release 8 (2026-11-07)

Release 8 removes the Node app from production: the relay (`src/legacy.rs`), `LEGACY_ORIGIN`, the
`app-blue` and `app-green` services, and the Node worker services, which releases 3 to 6 have
already removed. A slot is then its Corten container alone, which applies the migrations itself
(`MIGRATE_ON_START`, release 7). It was prepared on `codex/release-8-drop-node` and merged into
`codex/corten-port` once release 7 had been checked in production.

1. An `/api/...` path no route serves is the API's 404 in its `{"error": ..}` shape, and any other
   unknown path the app's own 404 page. The 31 Node routes nothing calls are retired
   (`docs/node-route-retirement.md`).
2. `npm run prod:update` and `prod:start` refuse to run unless `.env.production.local` sets every
   switch of releases 2 to 7 (`scripts/cortenSwitches.mjs`, its test in `npm test`), so no job
   is left with nothing to run it.
3. After traffic moves to the new slot, the release removes the old slot's Corten container and,
   by name, every Node container left from before (`NODE_CONTAINERS` in `scripts/prod.mjs`).
4. Rollback: release the previous master. Its compose file brings the Node app back in its slot.

Left for after release 8, since nothing in production uses them: `app/`, the Node build stages in
`Dockerfile`, the Node dev compose service and the parity scripts that run Node's code. The twin
and record scripts still need the Node app in dev, so they go with it.

## Decided (2026-11-05)

1. Refresh dev from production before release 1, then run the gate and the twin scripts against
   that copy (step 3 of Before release 1).
2. Browsers reach production through Tailscale Serve only. HTTPS ends there, so nginx stays plain
   HTTP and needs no TLS for release 1 (The proxy, point 4).
3. Each worker runs one full day of normal use in production before the next release moves
   another one.
4. Todd approved the merge into master and release 1 on 2026-11-05 ("release when confident").
   A production backup was taken first:
   `.artifacts/db-backups/2026-11-05T15-07-56Z-prod-before-release-1.dump`.

5. On 2026-11-07 Todd approved releases 3 to 8 to run back to back: each starts once the one
   before it has been checked in production (Checks after each release), without the full day
   between them that point 3 asked for.
