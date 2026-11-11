# Production Docker Deployment

The production stack is three containers: an nginx proxy on port `3001`, PostgreSQL, and the app, a Corten (Rust) server that serves every screen and JSON route, runs every background job and applies the SQL migrations as it starts (`MIGRATE_ON_START`). `docs/prod-cutover.md` records how it moved there from the Node app.

## Quick Start

Deploy the production stack:

```bash
npm run prod:deploy
```

The guarded `npm run prod:*` commands are the supported production entrypoints. `prod:deploy`, `prod:update`, `prod:start` and `prod:restart` fetch `origin/master` and refuse to run unless the local checkout is clean and `HEAD` exactly matches `origin/master`. They also refuse to run unless `.env.production.local` sets every job's switch (`scripts/cortenSwitches.mjs`), so no job is left with nothing to run it.

## Releases Without Downtime

The app runs in one of two slots, blue (`web-blue`) or green (`web-green`). `prod:deploy` (no-cache build) and `prod:update` (cached build) release the same way:

1. Build the image while the running slot keeps serving. A failed build changes nothing.
2. Start the idle slot, which applies pending migrations, and wait for its health check (`/health/ready`).
3. Point the proxy at the new slot and reload nginx. Requests already in flight finish on the old slot.
4. Stop the old slot after its in-flight requests finish.

If the new slot never becomes healthy, the release stops it and the old slot keeps serving.

`deploy/nginx/active/active.conf` records which slot receives traffic. It is written by the release and ignored by git; `http://localhost:3001/proxy-health` names the slot.

### Migrations

While the new slot migrates, the old slot is still serving against the migrated schema. The release only keeps it serving when that is safe:

- With no pending migrations, the old slot always keeps serving.
- Each pending migration must start with an `-- online: <why the running release keeps working>` line, and must not drop or rename a table or column, change a column type, set `NOT NULL`, or add a `NOT NULL` column without a default.
- Otherwise the release stops the old slot before migrating, and the app is down until the new slot is healthy, about half a minute.

Mark a migration online only when the previous release keeps working against it: adding tables, adding nullable or defaulted columns, adding indexes, and widening constraints usually qualify. Split a breaking change into an online expand migration now and the contracting migration in a later release.

The app holds an advisory lock while it migrates, so two slots never apply a migration at once. A failed migration stops the server before it serves, which the release sees as an unhealthy slot.

## Configuration

`.env.production.local` (read by both slots) sets each job's switch:

```bash
SELLER_ORDER_HISTORY_WORKER=1
PRICING_WORKER=1
CONTINUOUS_PRICING_SCHEDULER=1
SLAB_EVIDENCE_WORKER=1
PUBLICATION_WORKER=1
MIGRATE_ON_START=1
```

The app answers only to `localhost` and IP addresses unless told the names it is served under; any other `Host` gets `421`. If the app is reached by a name (`http://automation.lan:3001`, or a proxy that terminates HTTPS such as Tailscale Serve), list it there too (`HOSTS=automation.lan,.ts.net`; a leading dot takes every subdomain).

The production compose file sets:

```bash
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/tcgplayer_automation
SELLER_PORTAL_WRITES_ENABLED=true
```

Seller Portal posts (prices, quantities, staged pricing imports) change the live store. The app refuses them, and its publication worker claims nothing, unless `SELLER_PORTAL_WRITES_ENABLED=true`. Only this compose file sets it; development never does, so a local pricing run that plans a publication leaves it planned.

## Commands

```bash
npm run prod:deploy
npm run prod:update
npm run prod:start
npm run prod:stop
npm run prod:restart
npm run prod:logs
npm run prod:status
npm run prod:shell
npm run prod:clean
```

- `prod:deploy`, `prod:update`, `prod:start` and `prod:restart` are blocked unless the repo has no uncommitted changes and the checked-out commit matches `origin/master`.
- `prod:stop`, `prod:logs`, `prod:status`, `prod:shell` and `prod:clean` remain unguarded for operational use.
- The guard is commit-based, not branch-name-based, so a detached `HEAD` is allowed only when it points to the same commit as `origin/master`.

Direct Docker Compose commands bypass the source guard:

```bash
docker compose -f docker-compose.prod.yml --profile "*" logs -f
docker compose -f docker-compose.prod.yml --profile "*" ps
```

The app slots sit behind compose profiles, so pass `--profile "*"` to include them, and release through `npm run prod:deploy` rather than `up --build`, which would not switch the proxy.

## Refresh Dev Data From Production

```bash
npm run dev:db:refresh
```

This backs up the standalone development database (`docker-compose.db.yml`) to `.artifacts/db-backups/`, recreates it with the local migrations, and restores production's data into it.

## Persistence

PostgreSQL data is stored in the named Docker volume `postgres-data`. The app logs to its container (`npm run prod:logs`).

## Troubleshooting

```bash
npm run prod:status
npm run prod:logs
```

Clean rebuild:

```bash
npm run prod:clean
npm run prod:deploy
```

If port `3001` is already in use, change the host-side port mapping in `docker-compose.prod.yml`.
