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

Released the same day: merged as [#126 Corten port release 8: the Node app leaves production](https://github.com/todd-skelton/tcgplayer-automation-app/pull/126)
(0587ed02e, Corten 741b0a65) and released with `npm run prod:update` from a clean master at 16:21 UTC,
with every switch of releases 2 to 7 set. A backup was taken just before:
`.artifacts/db-backups/2026-11-07T16-02Z-prod-before-release-8.dump` (`pg_restore -l` lists 595
entries).

1. The green slot took over; the release removed blue's Corten container and, by name, the last Node
   container (`tcgplayer-automation-prod-blue`). `docker ps` lists only the proxy, postgres and
   `tcgplayer-automation-web-prod-green`, all healthy, and `/proxy-health` names green.
2. The `web` log has every worker's start line (pricing, schedule, slab, publication, order history)
   and no error, panic or warning.
3. All 16 screens answer 200 through port 3001 with no script error. An unknown path is the app's
   404 page (`Not found`), a retired route the API's 404 (`{"error":"Not Found"}`),
   `/api/pricing-config` 200 and `/favicon.ico` 200 `image/x-icon`.
4. The chain ran with no Node at all: the scheduler queued batch 7485 (16:29:52 UTC), the pricing worker
   completed job 7492 (1 row, 0 errors) and the publication worker posted 6080, `published` on the
   first attempt.

Left for after release 8, since nothing in production uses them: `app/`, the Node build stages in
`Dockerfile`, the Node dev compose service and the parity scripts that run Node's code. The twin
and record scripts still need the Node app in dev, so they go with it.

## Kit adoption (2026-11-07)

Todd approved it on 2026-11-07. Merged as [#129 Use the Corten kit's Combobox, CheckboxGroup, StatusDot, Stack and Cluster; pin Corten f4f37f95](https://github.com/todd-skelton/tcgplayer-automation-app/pull/129)
(22fb1179d, Corten f4f37f95) and released with `npm run prod:update` from a clean master at 23:10 UTC.
No migration and no switch changed. A backup was taken just before:
`.artifacts/db-backups/2026-11-07T23-00Z-prod-before-kit-adoption.dump` (`pg_restore -l` lists 595
entries).

Before it, production's database had stopped: the Docker disk it shares with local build caches
was full, postgres could not finish its checkpoint and restarted in a loop from about 22:40 UTC,
and the `web` container was unhealthy. Pricing job 7531 (batch 7524) failed with "No space left on
device". Removing unused build cache volumes freed space; postgres finished its crash recovery and
accepted connections at 22:51 UTC, and the next jobs (7563, 7564) completed and published.

1. The blue slot took over and green was removed. `/proxy-health` names blue and `docker ps` lists
   the proxy, postgres and `tcgplayer-automation-web-prod-blue`, all healthy.
2. The `web` log has every worker's start line. Order history run 4206 reached `complete`.
3. All 16 screens answer 200 through port 3001 with no script error in Chrome, `/favicon.ico` is
   200 `image/x-icon`. The Configuration and Price Matrix pickers render the kit's Combobox; the
   Configuration one opens and filters in Chrome (68 product lines, 48 after typing "a").
4. Job 7565 (batch 7558, full, 36 SKUs), which the slot change interrupted, was reclaimed on its
   second attempt by the blue slot's pricing worker and completed at 23:31 UTC: 36 rows, 0 errors,
   1 warning. Its publication (6151) was posted on the first attempt, 27 of 27 items `published`.

## Condition colors (2026-11-10)

Todd asked for it to be merged and released. The Inventory Manager's set, SKU and name take the
chosen condition's color again, as the React grid's did: merged as f6bb34d10, and released with
`npm run prod:update` from a clean master (102bee35e) at 16:39 UTC. No migration and no switch
changed. A backup was taken just before:
`.artifacts/db-backups/2026-11-10T16-38Z-prod-before-condition-colors.dump` (`pg_restore -l`
lists 595 entries).

Production was down from 09:05 UTC: Docker Desktop's WSL engine failed to start and its own
recovery kept failing, with 550 GB free on D:, so not the disk. Quitting Docker Desktop, `wsl
--shutdown` and starting it again brought every container back healthy at about 12:35 UTC.

The first release attempt failed to build: GitHub answers 404 for `corten-run/corten` while the
organization is under review, and the image fetches it without credentials. Nothing changed in
production. The image now builds Corten from a local git repository when `CORTEN_SOURCE` names
one (102bee35e); this release used `.artifacts/corten-source.git`, a bare repository holding
only f4f37f95 as `main`, made from the local Corten clone. Without `CORTEN_SOURCE` the build
fetches from GitHub as before.

1. The green slot took over and blue was removed. `/proxy-health` names green and `docker ps`
   lists the proxy, postgres and `tcgplayer-automation-web-prod-green`, all healthy.
2. The `web` log has every worker's start line, and order history reached `complete`.
3. All 16 screens answer 200 through port 3001. The Inventory Manager's Damaged view of Prize
   Pack Series Cards has 100 rows with red set and SKU badges and red names, and Chrome shows
   Heavily Played in orange.

## Corten 1e654688 and the kit's pagers (2026-11-10)

Todd asked for it to be merged and released. Corten moved from f4f37f95 to its main at
1e654688, and the port's pagers moved onto the kit: Continuous Pricing pages with the kit's
`Pagination`, and the Slab Pricing supply rows use the kit's `PreviousNext`, which now takes
`on:link` so a sorted table keeps its order while paging. Segmented controls take a width (`Fit`
where they drew at their own width before), the Batch Pricer's bars a tone, stats seven tokens
at the values the CSS had, and a kit Stack keeps a dialog child centered. Merged as adbb559b4
and released with `npm run prod:update` from a clean master at 20:24 UTC, building Corten from
GitHub (no `CORTEN_SOURCE`; GitHub answers anonymous requests again). No migration and no switch
changed. A backup was taken just before:
`.artifacts/db-backups/2026-11-10T20-15Z-prod-before-corten-1e654688.dump` (580 objects, the
same as the backup before condition colors).

1. The blue slot took over and green was removed. `/proxy-health` names blue and `docker ps`
   lists the proxy, postgres and `tcgplayer-automation-web-prod-blue`, all healthy.
2. The `web` log has every worker's start line and no error, and order history reached
   `complete` (1599 of 1599).
3. All 16 screens answer 200 through port 3001 with no console or page error, and the favicon
   answers 200. Continuous Pricing's pager goes to page 2 and back. Inventory Strategy's stats
   and segmented controls and Shipping Export's "Show as" measure the same as before the release
   at 1280 and 420 px wide.

## Corten 600771f9 and the kit's tokens (2026-11-11)

Todd approved the merge and release. Corten moved from 1e654688 to 600771f9: badges draw their
dots in the badge's text color (`StatusTone::Text`), cards take a `CardSize` (51 small, 16
medium), `Domain` gets its `AttrValue` from Corten instead of a hand-written impl, and five kit
tokens (choice-list gaps, tab weight and selected color, status dot size) carry the values the
CSS had. Merged as 801d9efd3 and released with `npm run prod:update` from a clean master; green
took over at 13:48 UTC. No migration and no switch changed. Backup just before:
`.artifacts/db-backups/2026-11-11T13-38Z-prod-before-pr131.dump` (580 objects).

1. Green took over and blue was removed; `/proxy-health` names green and the proxy, postgres and
   web containers are healthy.
2. The `web` log has every worker's start line and no error; order history reached `complete`
   (1591 of 1591).
3. All 16 screens answer 200 with no console or page error, and the favicon answers 200.
   Continuous Pricing's pager reaches page 2, the product line combobox finds "magic", segmented
   controls draw at weight 500, small cards keep 15px padding and a 12px gap, and dots measure
   7.5px in the badge's text color.
4. The JSON routes answer as before: pricing config, batches, publication health and forecast
   calibration 200, slab inventory without a query 400, FIFO by GET 405, a missing batch and an
   unknown route 404.

Before the release, the newest pricing job was from 07:01 UTC while 2268 SKUs had `next_price_at`
in the past. That was not a stall: every one of them is out of stock, paused or disabled, so none
is schedulable, and the hourly inventory refresh kept completing.

## Corten 3fb4b1ac: axum leaves Corten (2026-11-11)

Todd approved the merge and release. Corten no longer re-exports axum: the JSON routes, `api.rs`
and the label export take `Request`, `Body` and `Bytes` from `corten::http`, and the two test
stand-in servers depend on axum directly as a dev-dependency. Merged as a584b356d (its tree is the
gated branch head; master had only #131, which the branch contained) and released with
`npm run prod:update` from a clean master; the build took 9m 06s and blue took over at 14:07 UTC.
No migration and no switch changed. Backup just before:
`.artifacts/db-backups/2026-11-11T13-57Z-prod-before-pr132.dump` (580 objects).

1. Blue took over and green was removed; `/proxy-health` names blue and the proxy, postgres and
   `tcgplayer-automation-web-prod-blue` are healthy.
2. The `web` log has every worker's start line and no error; order history reached `complete`
   (1591 of 1591).
3. All 16 screens answer 200 through port 3001 with no console or page error in Chrome, and the
   favicon answers 200. Continuous Pricing's pager reaches page 2.
4. The JSON routes answer as after #131: pricing config, batches, publication settings and
   health, and forecast calibration 200 with `application/json`; slab inventory without a query
   400, FIFO by GET 405, a missing batch and an unknown route 404.

## The Node app's source leaves, and the catalog reads fractional ids (2026-11-11)

Todd approved both. #128 removes the Node app (`app/`, the Node scripts, the dev compose service,
`public/`, the Vite and React Router configs); the production image already built only the Rust
app, so nothing that runs changed. Merging master into it found one test still reading two slab
fixtures under `app/`; they moved to `tests/fixtures/node/slab/`. `typescript` stays as a dev
dependency so `corten check` can type-check the app's scripts. Merged as 7bd06ae5a. #135 fixes
Data Management's Sync new products, which failed with `invalid type: floating point 2002.0,
expected i64`: TCGplayer's search and product details now write counts and ids such as `2002.0`,
and the catalog reads them through `tcgplayer::whole`. Merged as fb0d850f2. Both were released
together with `npm run prod:update` from a clean master; green took over at 15:51 UTC. No
migration and no switch changed. Backup just before:
`.artifacts/db-backups/2026-11-11T15-40Z-prod-before-pr128-pr135.dump` (580 objects).

1. Green took over and blue was removed; `/proxy-health` names green and the proxy, postgres and
   `tcgplayer-automation-web-prod-green` are healthy.
2. The `web` log has every worker's start line and no error; order history reached `complete`
   (1590 of 1590).
3. All 16 screens answer 200 through port 3001 with no console or page error in Chrome, the
   favicon answers 200, Continuous Pricing's pager reaches page 2, and the JSON routes answer as
   before.
4. Sync new products for Pokemon, run from master against the dev database and TCGplayer's live
   answers, completed in 107 s and verified each changed set (ME06: Delta Reign 143 new products,
   1150 SKUs). It was not run against production.

The first `prod:update` stopped before building: a `.react-router/` folder of generated types,
last written 2026-11-07 and no longer ignored after #128, left the tree dirty. It was deleted.
## Issue triage: retries, rescheduling, a shrunk forecast, Corten 3699bd64 (2026-11-11)

Open issues were read against the Rust code; the ones still relevant were fixed, and the rest were closed or left open with a reason.

1. #136 pins Corten 3699bd64. Nothing under crates/ changed since 3fb4b1ac (examples, bench and docs only).
2. #138 renews a pricing job's claim on the connection that claimed it, and logs where a renewal cut off by the 2 s timeout was waiting and the pool's state (#127).
3. #139 retries TCGplayer reads (never Seller Portal writes) when TCGplayer cannot be reached; a failed pricing job or a rolled-back continuous publication counts as a failed pricing of its SKUs and brings them back within 15 minutes (third in a row pauses for review); a refused staged upload keeps Seller Portal's messages and accepted count (#133, #134).
4. #137 records a Gamma-Poisson shrunk sale-rate forecast (gamma-poisson-v1, a 7-day prior pooled per product line from each SKU's latest modeled result in the last 30 days) beside the other forecasts, and grades all five with Brier scores at 14, 21 and 28 days on the configuration page. Pricing does not read it (#16).
5. #141 shows N/A for a forecast no published price has carried yet, instead of its prior's 1.00.
6. #80 closed: migration 045 (845670665) already backfilled those publications as receipt lots with listing history coverage; a Rust port of the draft estimate passed the gate but would have reported nothing, so it was dropped. Draft PRs #38, #53 and #81 closed: they change the removed Node app.
7. Left open: #127 (see below), #17 (needs the grading from #137 and a cohort fit), #18 (needs a band decision), the slab epic #19 and #24, #29 to #33 (blocked on eBay seller access).

Releases: blue went live at 18:38 UTC with #136 to #139 (backup 2026-11-11T18-29Z-prod-before-pr136-139.dump, 580 objects); green at 19:44 UTC with #141 (backup 2026-11-11T19-31Z-prod-before-pr141.dump, 580 objects). Both swaps: containers healthy, proxy-health 200, 16 screens 200 with no console errors, JSON routes as before, order history complete. Job 8091 (50 SKUs) completed after the first swap with 49 shrunk forecasts recorded, all from the stored pool; job 8092 was released on the second swap and requeued as designed.

The first renewal cut off after #138 logged `running its update on the job's connection (pool: 11 open, 10 idle)`: the wait in #127 is the UPDATE itself, not connection acquisition. The lease is 15 s, so one cut-off renewal costs only the log line.
## Issue triage: renewal budget, quality-aware win share, client-side set search, Corten 0.2.0 (2026-11-11)

The blockers were skipped as Todd asked (#18 needs a band decision; the slab epic #19, #24 and #29 to #33 waits on eBay seller access). The rest were fixed or closed.

1. #143 pins Corten b7c8143b: the runtime does less work at startup on a long page (corten-run/corten#1246). Only corten.js changed since 3699bd64.
2. #142 gives a pricing job renewal and a progress save a third of the lease (5 s) before giving up, instead of one 2 s heartbeat; a compile-time check keeps two given-up renewals in a row inside the 15 s lease (#127, which stays open until the log stays quiet).
3. #144 records a sixth forecast, a quality-aware win share (quality-share-provisional-v1): each competing ask weighted by copies, seller quality and price against the curve's median, graded beside the other five. Pricing does not read it. The constants are provisional until seller quality is stored and a cohort fit can run (#17).
4. #145 brings a set's products to the Inventory Manager once and searches, sorts and pages them in the browser by the server's rule (card numbers, then names); All sets still searches on the server. Page Up and Page Down start a fresh search in the next set with focus in the search box (#140). Corten gaps filed: corten-run/corten#1253, #1254, #1255, #1256.
5. #146 pins Corten 74d15fea, the 0.2.0 release plus corten-run/corten#1247 (CONNECT tunnels and the header timeout); Cargo.lock moves only the Corten packages.
6. #147 pins Corten 1124e130, which sets TCP_NODELAY on every connection Corten accepts (corten-run/corten#1250), so back-to-back live answers behind nginx keepalive do not wait for a delayed ACK. Only listener.rs changed.
7. #148 pins Corten a7e02c39, which adds corten::caller::bearer (corten-run/corten#1252). The port reads no incoming Authorization header, so nothing switches to it. Green went live at 03:12 UTC on 2026-11-12 (backup 2026-11-12T02-58Z-prod-before-pr148.dump, 580 objects) with the same checks passing.
8. #149 pins Corten 3cd08920: RFC 4647 locale Lookup (corten-run/corten#1268) and a 400 for an unsupported MCP-Protocol-Version (corten-run/corten#1263). The port ships only en and no MCP endpoint, so neither changes its behavior; a fr-CA Accept-Language still answers in en. Blue went live at 05:19 UTC on 2026-11-12 (backup 2026-11-12T05-07Z-prod-before-pr149.dump, 580 objects) with the same checks passing.
9. #150 pins Corten 1905151a: a write or WebSocket handshake without Sec-Fetch-Site is held to its whole origin against Host (corten-run/corten#1248), and @scope rules are prefixed (#1265). The stricter https-or-loopback rule applies only under Policy::hsts, which the port does not set: HTTPS ends at Tailscale Serve and nginx passes the browser's Host through. Browser writes carry Sec-Fetch-Site and the port opens no WebSockets. Green went live at 06:45 UTC on 2026-11-12 (backup 2026-11-12T06-30Z-prod-before-pr150.dump, 580 objects).
10. #151 pins Corten 31e0443a, whose html! refuses an app path written as text in a URL attribute (corten-run/corten#1267). Three links now name their routes (InventoryManager, PublicationSettings) and render the same paths. Blue went live at 07:23 UTC (backup 2026-11-12T07-05Z-prod-before-pr151.dump, 580 objects). Both swaps: containers healthy, proxy-health 200, 16 screens 200 with no console errors, JSON routes as before, order history complete, log clean.
11. #152 pins Corten 794e6c7f: a switched connection counts against App::max_connections until its route drops it (corten-run/corten#1275). The port sets no connection cap and opens no switched sockets, so nothing migrates. The range also has corten-ui's NumberField and ComboBox follow a form reset; in production Chrome a stepped NumberField and a filtered ComboBox both returned to their drawn values on reset, with no request. Green went live at 16:43 UTC on 2026-11-12 (backup 2026-11-12T16-26Z-prod-before-pr152.dump, 580 objects) with the same checks passing. The host had rebooted at 09:22 UTC and the database and proxy came back at 09:29 UTC; blue was running at the swap and priced jobs at 14:00 and 15:18 UTC.
12. #153 pins Corten 1e0cd390, which writes data-on single-quoted so a handler argument's JSON keeps its quotes (corten-run/corten#1281, fixing corten-run/corten#1253). The Inventory Manager's set listing no longer carries an escaped quote per JSON quote, so large sets send markedly smaller pages. In Chrome the in-set search on the largest set matched the server with no request, and Page Down still left focus in an empty search. Blue went live at 20:40 UTC on 2026-11-12 (backup taken first) with the same checks passing.
13. #154 pins Corten 921cd842, which gives a template's copied forms submit keys of their own (corten-run/corten#1276, closing corten-run/corten#1254). The Inventory Manager's row template draws SubmitKey::template_field and IntakeRow takes its key field as a SubmitField prop, so the page's rows keep SubmitKey::field; the server no longer parses a key out of SubmitKey::field's HTML and the script mints no UUIDs. On the dev database in Chrome, two counts on rows copied from the template sent distinct keys and both applied. Green went live after a backup with the same checks passing; in production Chrome, stepping the condition redrew the page's rows from the template keyless, with no request. The image build waited on other apps' builds sharing the template's target cache (corten-run/corten#1345).
14. #155 pins Corten 87344049: a method no route in the app names answers 501 with Failure::UnknownMethod, not 405 (corten-run/corten#1344). The error page matches Failure exhaustively, so it draws UnknownMethod as it draws WrongMethod; the app's own JSON 405s are its handlers' and unchanged. The range's WebSocket refusal headers (corten-run/corten#1365), refused-link logging (corten-run/corten#1271), per-area scope and FromJson's single reading of serde attributes need nothing here. Blue went live after a backup with the same checks passing.
15. #163 pins Corten 5696f124; nothing under crates/ changed since 87344049.
16. A framework review of the port filed corten-run/corten#1399 to #1403 and, while making the changes, #1406 to #1410 (typed script reads of a page's data, the cost of a slow part, kit look constants, a kit submit-on-change script, a query set per write action, a GET patch's address, handler types, form fields as script elements, a patch's table row, refs in a part sent alone).
17. #164 fills the order labels form's package in the browser for each service and shows each labels choice's note without a request; without JavaScript, Apply reads the order from the stored workflow instead of TCGplayer (#157). #165 draws Inventory Strategy's dashboard at once and streams its slow panels through corten-live, with a patched scope change (#158). #166 patches the continuous pricing SKU toggle and the Inventory Manager's set choice, with a set seen in the last five minutes served from the browser cache (#159, #160).
18. #168 retires the /api JSON routes, which nothing called (#156), and the operator actions only they reached; #167 decides which of those need a screen. #169 logs with tracing, times each request in the proxy log, and reads .env files from the working directory only (#162).
19. One release carried #164 to #169 after a backup, with the same checks passing; /api now answers 404. In production Chrome the labels form's service and labels changes sent no request, the strategy streams ended, and a set switch was one patch request with the address updated.
20. #16 closed as delivered by #137; adopting the shrunk forecast waits for weeks of graded cohorts.
21. #170 reads the settings, shipping measures and slab choices as typed form fields: numbers as Entry<f64>, the slab basis, selection and decision as enums with the same stored words, and the turnaround source as an optional mode. A select word the page never sends is now refused with Corten's 422, a non-numeric grade is refused instead of saved as unmapped, and a missing letter or flat limit draws its field message. It found corten-run/corten#1412 (Bounds has no step any or exclusive ends) and corten-run/corten#1413 (an enum field's unknown word fails the whole form).
22. #171 pins Corten 3bafe4ee (benchmarks only since 5696f124) and gives the image build's target cache the id tcgplayer-automation-target, so other apps' builds on the host no longer hold its lock (corten-run/corten#1345; the template change is corten-run/corten#1414). The first build under the new id is cold. One release carried #170 and #171 after a backup; blue went live with the same checks passing, and in production Chrome the configuration and shipping settings drew every stored number in their typed fields with no console error.
23. #172 finishes #161: FIFO replay binds its recordsets from typed rows, batch pricing progress is a typed Step, the strategy dashboard keeps its policy typed until it is written, TCGplayer's loose numbers read through an untagged enum, and slab maintenance reads its numbers through their Bounds. Comments describe what the code does; the ones left naming Node point at parity fixtures or script tests run under Node. It pins Corten d1cb28f9 and adopts the template's build step from corten-run/corten#1414: cargo's whole home is a cache every build on the host shares. Green went live after a backup with the same checks passing, and a pricing job running on it saved its progress in the same shape.
24. #176 removes the quality-aware win share forecast (#173): pricing no longer computes it or reads seller quality from the listings search, new publication items no longer carry qualityShareForecast, the calibration report drops its row, and planning a publication again compares plans without that key so older plans still match. #177 keeps what Seller Portal answered when it refuses a staged upload with no count and no messages (status, content type, redirect, response shape, fields and time to answer) and logs a warning, for #175; its migration drops the unused forecast_correction_events and forecast_evaluations tables (#174). The migration is not online, so the release stopped the live slot before migrating, a brief outage. Blue went live after a backup with the same checks passing; the calibration report loads without the row, and items planned after the swap lack the key.
25. #178 brings back one operator action /api had reached, for #167: the Batch Pricer shows a batch's ambiguous publication items, and an item that adds received inventory can be confirmed live with the quantity seen, when (a datetime-local read in the visitor's zone) and a note. One transaction locks the publication and the item, publishes it, activates its receipt lots for the seller with the note as evidence, and publishes the publication once no item is left without an outcome; the same confirmation again is answered as the first was. It found corten-run/corten#1421 (no typed datetime-local reader), #1419 (check --help) and #1420 (check is silent while its test build runs).
26. #179 pins Corten 0ff569c6 (corten-run/corten#1386, typed ref values): data-ref-value is now printed by Corten, and the port writes it nowhere, so only the lock file moves. One release carried #178 and #179 after a backup; green went live with the same checks passing, and the Batch Pricer drew no repair card because nothing was ambiguous.
27. #180 pins Corten 9c867b5e (corten-run/corten#1405): a debug build answers a browser's plain post to a route with no GET, answered with a page, with a 500 (corten-run/corten#1340). Of the 66 post-only routes, three did that: Data Management's jobs and Slab Connections' save, check and remove now redirect to their screen with what they did as the notice, and the label form's Apply posts to the label screen's own route and, without JavaScript, is answered with the screen where it had answered a bare form fragment (filed as corten-run/corten#1423, which the new check does not catch). Without JavaScript in Chrome on the dev database, each landed on its screen with its notice and none was a 500. Blue went live after a backup with the same checks passing.

Releases: blue went live at 22:20 UTC with #142 to #144 (backup 2026-11-11T21-58Z-prod-before-pr142-144.dump, 580 objects); green at 23:14 UTC with #145 and #146 (backup 2026-11-11T22-59Z-prod-before-pr145-146.dump, 580 objects); blue at 23:51 UTC with #147 (backup 2026-11-11T23-40Z-prod-before-pr147.dump, 580 objects). All three swaps: containers healthy, proxy-health 200, 16 screens 200 with no console errors, JSON routes as before, order history complete. Every publication item written after the first swap carries qualityShareForecast. On the Inventory Manager in production, typing a search in a set sent no request and matched the no-JavaScript answer; Enter focused the first quantity field; Page Down loaded the next set with an empty search, focus in the search box; All sets still asked the server.
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
