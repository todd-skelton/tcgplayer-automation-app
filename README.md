# TCGPlayer Automation App

The app is a [Corten](https://github.com/corten-run/corten) server in Rust (`src/`): every screen and background job, over one PostgreSQL database. It serves no JSON API; the `/api` routes were retired ([Retiring the Node JSON routes](docs/node-route-retirement.md)). The repo includes checked-in SQL migrations (`db/migrations`), which the server applies as it starts when `MIGRATE_ON_START` is set, and Docker Compose files for the development database and production. The Node scripts in `scripts/` are tooling only: releases, migrations and the dev database refresh.

Inventory Manager supports background pricing and per-batch publication while entering new stock. See [Inventory intake queue](docs/inventory-intake-queue.md) for handoff, recovery, and rollout safeguards.

Data Management can sync only the products TCGplayer added since the last sync, using per-set counts instead of a full product line pass. See [Sync new products](docs/catalog-sync.md).

## Requirements

- Rust (stable) and the `corten` command at the version `Cargo.lock` pins (`corten --version` says which; `cargo install corten-cli`)
- Node.js 20 (for the `npm run` tooling)
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

Optional EasyPost shipping flags:

```bash
EASYPOST_TEST_API_KEY=your_test_key
EASYPOST_PRODUCTION_API_KEY=your_production_key
```

The shipping exporter uses these server-side keys for direct postage purchase.
The selected EasyPost mode is stored in Shipping Configuration, defaults to
`test`, and falls back to CSV export when the corresponding key is missing.

For local development, keep shared settings such as `DATABASE_URL` in
`.env.local`, put the EasyPost test key in `.env.development.local`, and put
the live EasyPost key for deploys in `.env.production.local`. These files are
gitignored; use `.env.local.example`, `.env.development.local.example`, and
`.env.production.local.example` as the templates.

The server and the npm scripts load environment files by mode (`NODE_ENV`)
without overriding values that are already present in the shell:

```bash
development: .env.development.local, .env.local, .env.development, .env
production: .env.production.local, .env.production, .env
```

## Local Development

```bash
npm run dev
```

That starts the standalone PostgreSQL development container from `docker-compose.db.yml` (host port `5433`), applies the local migrations, and runs `corten dev --port 3000`. Open `http://localhost:3000`; it rebuilds and reloads on every change and reads the same `.env` files. With the database already up, `corten dev --port 3000` alone is enough.

`corten check` runs the formatter, clippy and the tests. Tests that need the dev database are ignored and run with `cargo test -- --ignored`; the parity tests among them compare with the Node app's answers recorded in `tests/fixtures` before it was retired.

Useful commands around local development:

```bash
npm run dev:db:up
npm run dev:db
npm test
```

`npm run dev:db:up` starts only the database, `npm run dev:db` opens `psql` in it, and `npm test` runs the tests of the release scripts. The compose file uses the explicit project name `tcgplayer-automation-db`, so it can run beside the production stack without sharing Docker networks.

## Database Commands

Apply migrations:

```bash
npm run db:migrate
```

It applies the same files the server applies under `MIGRATE_ON_START`, holding the same advisory lock.

Refresh the development database from the running production PostgreSQL container:

```bash
npm run dev:db:refresh
```

The refresh command creates a timestamped backup in `.artifacts/db-backups/` before replacing the development database, and starts the standalone database from `docker-compose.db.yml` if it is not running.

## Production Docker

Build and start the production stack:

```bash
npm run prod:deploy
```

The production app is exposed at `http://localhost:3001`.
The production Docker stack reads `.env.production.local`, so production uses
the live EasyPost API on deploy.

The app answers only to `localhost`, IP addresses and the names listed in `HOSTS`; any other `Host` gets 421. When the app is reached by a name (`automation.lan`, or a reverse proxy that terminates HTTPS such as Tailscale Serve at `https://<machine>.<tailnet>.ts.net` proxying to `http://localhost:3001`), list it in `.env.production.local` (`HOSTS=automation.lan,.ts.net`; a leading dot takes every subdomain) and restart.

When you deploy through `npm run prod:deploy`, `npm run prod:update`, `npm run prod:start`, or `npm run prod:restart`, the repo fetches `origin/master` and refuses to run unless the working tree is clean and local `HEAD` exactly matches `origin/master`. This keeps production aligned with the remote `master` branch instead of whichever local branch happens to be checked out. Direct `docker compose -f docker-compose.prod.yml ...` commands still work, but they bypass that protection.

Additional production workflow details are documented in `PRODUCTION_DOCKER.md`.
