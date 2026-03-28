# TCGPlayer Automation App

This app now uses PostgreSQL for server-side storage. The repo includes checked-in SQL migrations, a NeDB-to-Postgres import script, and Docker Compose workflows for container-first development and production.

## Requirements

- Node.js 20
- npm
- Docker Desktop or another Docker runtime

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
DB_IMPORT_ON_START=false
```

## Local Development

Run the full development stack in Docker:

```bash
npm run dev
```

That starts the app on `http://localhost:5173` and Postgres on `localhost:5432`. The development stack uses `docker-compose.yml` with the explicit project name `tcgplayer-automation-dev`.

Useful Docker-first development commands:

```bash
npm run dev:logs
npm run dev:down
npm run dev:db
```

To import the checked-in NeDB files into the containerized development database:

```bash
docker compose run --rm app npm run db:import
```

### Host App Fallback

If you want to run the app on your host instead of in Docker, start the standalone dev database and use the explicit host-mode script:

```bash
docker compose -f docker-compose.db.yml up -d
npm install
npm run db:migrate
npm run db:import
npm run dev:host
```

The app is available at `http://localhost:5173`.

If you are using the standalone database container from `docker-compose.db.yml`, the app defaults to `localhost:5433` automatically. That compose file uses the explicit project name `tcgplayer-automation-db`, so it can run beside both the production stack and the full dev stack without sharing Docker networks.

## Database Commands

Apply migrations:

```bash
npm run db:migrate
```

Import legacy `.db` files from `data/`:

```bash
npm run db:import
```

The import is upsert-based, so rerunning it does not duplicate rows.

## Production Docker

Build and start the production stack:

```bash
npm run prod:deploy
```

The production app is exposed at `http://localhost:3001`.

Docker may label the built image as `tcgplayer-automation-app-app`. That image name comes from the repository directory and service name, not the Compose project name. The actual project names are `tcgplayer-automation-prod`, `tcgplayer-automation-dev`, and `tcgplayer-automation-db`.

When you deploy through `npm run prod:deploy`, `npm run prod:update`, `npm run prod:start`, or `npm run prod:restart`, the repo now fetches `origin/master` and refuses to run unless the working tree is clean and local `HEAD` exactly matches `origin/master`. This keeps production aligned with the remote `master` branch instead of whichever local branch happens to be checked out.

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

- Full dev stack: `npm run dev`
- Production stack: `npm run prod:deploy`
- Standalone dev database: `docker compose -f docker-compose.db.yml up -d`

The cleanup removes containers and the old shared network only. Your named Docker volumes, including the PostgreSQL data volumes, are preserved. If the old network is already gone, Docker may print an error that you can ignore.
