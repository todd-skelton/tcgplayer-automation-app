# TCGPlayer Automation App

This app now uses PostgreSQL for server-side storage. The repo includes checked-in SQL migrations and Docker Compose workflows for development databases and production.

## Requirements

- Node.js 20
- npm
- Docker Desktop or another Docker runtime for the PostgreSQL dev database and production containers

## Environment

The server uses `DATABASE_URL`. The host-run fallback default is:

```bash
postgresql://postgres:postgres@localhost:5433/tcgplayer_automation
```

That fallback is intended for host-based development against the standalone dev database in `docker-compose.db.yml`.

Optional startup flags:

```bash
DB_STARTUP_RETRIES=30
DB_STARTUP_DELAY_MS=2000
```

## Local Development

Run the app directly on your host for normal hot reload:

```bash
npm run dev
```

That starts the app on `http://localhost:5173` in the terminal process instead of inside a container. It also starts the standalone PostgreSQL development container from `docker-compose.db.yml` and applies local migrations before launching the dev server.

If you are using the standalone database container from `docker-compose.db.yml`, the app defaults to `localhost:5433` automatically. That standalone database flow is the host-accessible PostgreSQL option for development. The compose file uses the explicit project name `tcgplayer-automation-db`, so it can run beside both the optional Docker app stack and the production stack without sharing Docker networks.

Useful commands around local development:

```bash
npm run dev:host
npm run dev:app
npm run dev:docker
npm run dev:logs
npm run dev:down
npm run dev:db
```

`npm run dev:host` is an explicit alias for the same host-run development flow as `npm run dev`. `npm run dev:app` starts only the host app process and assumes the standalone database is already running. `npm run dev:docker` still starts the full Docker app stack when you want the app itself inside a container.

`npm run dev:db` opens `psql` inside the running `postgres` container for the full Docker dev stack.

### Optional Docker App Stack

If you want to run the app in Docker too, use the explicit Docker script:

```bash
npm run dev:docker
```

That starts the app on `http://localhost:5173` through `docker-compose.yml` with the explicit project name `tcgplayer-automation-dev`. The PostgreSQL container stays internal to that Docker network, so the full Docker app stack does not depend on host port `5432` being free.

## Database Commands

Apply migrations:

```bash
npm run db:migrate
```

Refresh a development database from the running production PostgreSQL container:

```bash
npm run dev:db:refresh
```

Optional target selectors:

```bash
npm run dev:db:refresh -- --target=dev
npm run dev:db:refresh -- --target=db
```

The refresh command creates a timestamped backup in `.artifacts/db-backups/` before replacing the target database. By default it auto-detects which dev database to refresh. If neither dev target is running, it starts the standalone database from `docker-compose.db.yml`. If both are running, it exits and asks for an explicit `--target` because the full Docker dev stack and the standalone dev database use separate Docker volumes.

## Production Docker

Build and start the production stack:

```bash
npm run prod:deploy
```

The production app is exposed at `http://localhost:3001`.

Docker may label the built image as `tcgplayer-automation-app-app`. That image name comes from the repository directory and service name, not the Compose project name. The actual project names are `tcgplayer-automation-prod`, `tcgplayer-automation-dev`, and `tcgplayer-automation-db`.

When you deploy through `npm run prod:deploy`, `npm run prod:update`, `npm run prod:start`, or `npm run prod:restart`, the repo now fetches `origin/master` and refuses to run unless the working tree is clean and local `HEAD` exactly matches `origin/master`. This keeps production aligned with the remote `master` branch instead of whichever local branch happens to be checked out.

The `prod:*` commands are implemented through a cross-platform Node wrapper now, so the same npm entrypoints work on both Windows and Unix-like shells.

Direct `docker compose -f docker-compose.prod.yml ...` commands still work, but they bypass that protection. Use the `npm run prod:*` wrappers whenever you want enforced production source control.

Additional production workflow details are documented in `PRODUCTION_DOCKER.md`.

## One-Time Docker Cleanup

If Docker Desktop still shows a legacy `tcgplayer-automation-app` stack, remove the stale containers and network once before recreating the environments:

```bash
docker compose down --remove-orphans
docker compose -f docker-compose.db.yml down --remove-orphans
docker compose -f docker-compose.prod.yml down --remove-orphans
docker rm -f tcgplayer-automation-prod tcgplayer-automation-dev tcgplayer-postgres-prod tcgplayer-postgres-dev tcgplayer-postgres-db
docker network rm tcgplayer-automation-app_default
```

Then recreate only the environments you need:

- Host app server: `npm run dev`
- Full Docker dev stack: `npm run dev:docker`
- Production stack: `npm run prod:deploy`
- Standalone dev database: `docker compose -f docker-compose.db.yml up -d`

The cleanup removes containers and the old shared network only. Your named Docker volumes, including the PostgreSQL data volumes, are preserved. If the old network is already gone, Docker may print an error that you can ignore.
