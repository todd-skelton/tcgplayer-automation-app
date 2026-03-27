# TCGPlayer Automation App

This app now uses PostgreSQL for server-side storage. The repo includes checked-in SQL migrations, a NeDB-to-Postgres import script, and Docker Compose workflows for both development and production.

## Requirements

- Node.js 20
- npm
- Docker Desktop or another Docker runtime

## Environment

The server uses `DATABASE_URL`. The local default is:

```bash
postgresql://postgres:postgres@localhost:5433/tcgplayer_automation
```

Optional startup flags:

```bash
DB_STARTUP_RETRIES=30
DB_STARTUP_DELAY_MS=2000
DB_IMPORT_ON_START=false
```

## Local Development

Run Postgres in Docker and the app on your host:

```bash
docker compose up -d postgres
npm install
npm run db:migrate
npm run db:import
npm run dev
```

The app is available at `http://localhost:5173`.

If you are using the standalone database container from `docker-compose.db.yml`, the app now defaults to `localhost:5433` automatically.

Run the full development stack in Docker:

```bash
docker compose up --build
```

That starts the app on `http://localhost:5173` and Postgres on `localhost:5432`.

To import the checked-in NeDB files into the containerized database:

```bash
docker compose run --rm app npm run db:import
```

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

When you deploy through `npm run prod:deploy`, `npm run prod:update`, `npm run prod:start`, or `npm run prod:restart`, the repo now fetches `origin/master` and refuses to run unless the working tree is clean and local `HEAD` exactly matches `origin/master`. This keeps production aligned with the remote `master` branch instead of whichever local branch happens to be checked out.

Direct `docker compose -f docker-compose.prod.yml ...` commands still work, but they bypass that protection. Use the `npm run prod:*` wrappers whenever you want enforced production source control.

Additional production workflow details are documented in `PRODUCTION_DOCKER.md`.
