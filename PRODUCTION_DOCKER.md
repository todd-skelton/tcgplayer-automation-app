# Production Docker Deployment

The production stack runs the app and PostgreSQL together. The app is moving from React Router (Node) to Corten (Rust) one screen at a time, so it runs as two containers: the Node app, which waits for the database, applies SQL migrations during startup, and serves the screens not yet ported, and the Corten app in front of it (`web`), which serves the ported screens and relays every other request to the Node app. An nginx proxy owns port `3001` and forwards requests to the Corten app.

## Quick Start

Deploy the production stack:

```bash
npm run prod:deploy
```

The guarded `npm run prod:*` commands are the supported production entrypoints when you want source enforcement. `prod:deploy`, `prod:update`, `prod:start`, and `prod:restart` fetch `origin/master` and refuse to run unless the local checkout is clean and `HEAD` exactly matches `origin/master`.

Those `prod:*` commands now route through a cross-platform Node wrapper, so the same npm commands work from Windows and Unix-like shells without separate `.bat` and `.sh` entrypoints.

## Releases Without Downtime

The app runs in one of two slots, blue or green. A slot is the Node app (`app-blue`) and the Corten app that relays to it (`web-blue`). `prod:deploy` (no-cache build) and `prod:update` (cached build) release the same way:

1. Build both images while the running slot keeps serving. A failed build changes nothing.
2. Start the idle slot's Node app, which applies pending migrations, and wait for its health check; then start its Corten app and wait for that one's.
3. Point the proxy at the new slot's Corten app and reload nginx. Requests already in flight finish on the old slot.
4. Replace the background workers with the new image, then stop the old slot after its in-flight requests finish.

If the new slot never becomes healthy, the release stops it and the old slot keeps serving.

`deploy/nginx/active/active.conf` records which slot receives traffic. It is written by the release and ignored by git.

### Migrations

While the new slot migrates, the old slot is still serving against the migrated schema. The release only keeps it serving when that is safe:

- With no pending migrations, the old slot always keeps serving.
- Each pending migration must start with an `-- online: <why the running release keeps working>` line, and must not drop or rename a table or column, change a column type, set `NOT NULL`, or add a `NOT NULL` column without a default.
- Otherwise the release stops the old slot and the workers before migrating, and the app is down until the new slot is healthy, about half a minute.

Mark a migration online only when the previous release keeps working against it: adding tables, adding nullable or defaulted columns, adding indexes, and widening constraints usually qualify. Split a breaking change into an online expand migration now and the contracting migration in a later release.

This starts:

- The proxy on `http://localhost:3001` and the app in the active slot
- PostgreSQL in a sidecar container
- Persistent database storage in the `postgres-data` Docker volume

The production compose file uses the explicit project name `tcgplayer-automation-prod`, so it can run beside the full dev stack `tcgplayer-automation-dev` and the standalone dev database `tcgplayer-automation-db` without sharing Docker networks.

Docker may show the built image name as `tcgplayer-automation-app-app`. That is only the generated image name. The Compose project name for the production stack is still `tcgplayer-automation-prod`.

## Configuration

The Corten app answers only to `localhost` and IP addresses unless told the names it is served under; any other `Host` gets `421`. If the app is reached by a name (`http://automation.lan:3001`), list it in `.env.production.local`:

```bash
HOSTS=automation.lan
```

The production compose file sets:

```bash
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/tcgplayer_automation
```

Optional startup flags:

```bash
DB_STARTUP_RETRIES=30
DB_STARTUP_DELAY_MS=2000
```

## Commands

NPM wrappers:

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

Source guard behavior:

- `prod:deploy`, `prod:update`, `prod:start`, and `prod:restart` are blocked unless the repo has no uncommitted changes and the checked-out commit matches `origin/master`.
- `prod:stop`, `prod:logs`, `prod:status`, `prod:shell`, and `prod:clean` remain unguarded for operational use.
- The guard is commit-based, not branch-name-based, so a detached `HEAD` is allowed only when it points to the same commit as `origin/master`.

Direct Docker Compose commands:

```bash
docker compose -f docker-compose.prod.yml --profile "*" down
docker compose -f docker-compose.prod.yml --profile "*" logs -f
docker compose -f docker-compose.prod.yml --profile "*" ps
```

Direct `docker compose` commands bypass the source guard. Use the `npm run prod:*` wrappers if you need the `origin/master` enforcement. The app slots sit behind compose profiles, so pass `--profile "*"` to include them, and release through `npm run prod:deploy` rather than `up --build`, which would not switch the proxy.

## Refresh Dev Data From Production

If you need current production data in development, refresh a dev database from the running production PostgreSQL container:

```bash
npm run dev:db:refresh
```

Optional target selectors:

```bash
npm run dev:db:refresh -- --target=dev
npm run dev:db:refresh -- --target=db
```

This workflow creates a timestamped backup in `.artifacts/db-backups/` before overwriting the selected development database. The default behavior auto-detects which dev database is running. If neither dev target is running, it starts the standalone database and refreshes that one. If both are running, the command exits and requires `--target` because the full Docker dev stack and the standalone dev database use separate Docker volumes.

## One-Time Cleanup After Upgrading

If Docker Desktop still shows the legacy `tcgplayer-automation-app` project, remove the stale containers and network once and then recreate the stacks:

```bash
docker compose down --remove-orphans
docker compose -f docker-compose.db.yml down --remove-orphans
docker compose -f docker-compose.prod.yml down --remove-orphans
docker rm -f tcgplayer-automation-prod tcgplayer-automation-dev tcgplayer-postgres-prod tcgplayer-postgres-dev tcgplayer-postgres-db
docker network rm tcgplayer-automation-app_default
docker compose -f docker-compose.prod.yml up -d --build
```

If you also want a development environment available again, recreate only the one you need:

- Full dev stack: `npm run dev`
- Standalone dev database: `docker compose -f docker-compose.db.yml up -d`

These commands remove containers and the old shared network only. The named PostgreSQL volumes are preserved. If the old network is already gone, Docker may print an error that you can ignore.

Run migrations manually:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps app-blue npm run db:migrate
```

## Persistence

- PostgreSQL data is stored in the named Docker volume `postgres-data`.
- Application logs use the persistent `app-logs` Docker volume and remain available through `npm run prod:logs`.

## Troubleshooting

Check status and logs:

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
