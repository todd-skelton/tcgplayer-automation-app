# TCGPlayer Automation App

The screens are a [Corten](https://github.com/corten-run/corten) app in Rust (`src/`). The Node app in `app/` no longer draws any screen: until cutover it answers its JSON routes (`/api/...`), runs the background workers and applies the migrations, and the Corten app relays every path it does not serve to it, so one origin serves both. Both share one PostgreSQL database; the repo includes checked-in SQL migrations (`db/migrations`) and Docker Compose workflows for development databases and production.

Inventory Manager supports background pricing and per-batch publication while entering new stock. See [Inventory intake queue](docs/inventory-intake-queue.md) for handoff, recovery, and rollout safeguards.

Data Management can sync only the products TCGplayer added since the last sync, using per-set counts instead of a full product line pass. See [Sync new products](docs/catalog-sync.md).

## Requirements

- Rust (stable) and the `corten` command at the version `Cargo.lock` pins (`corten --version` says which; `cargo install corten-cli`)
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

Node-based commands load environment files by mode without overriding values
that are already present in the shell:

```bash
development: .env.development.local, .env.local, .env.development, .env
production: .env.production.local, .env.production, .env
```

## Local Development

Run the app directly on your host for normal hot reload:

```bash
npm run dev
```

That starts the Node app on `http://localhost:5173` in the terminal process instead of inside a container. It also starts the standalone PostgreSQL development container from `docker-compose.db.yml` and applies local migrations before launching the dev server.

Then run the screens in another terminal:

```bash
corten dev --port 3000
```

and open `http://localhost:3000`. It rebuilds and reloads on every change, reads the same `.env` files, and relays the JSON routes to the Node app at `LEGACY_ORIGIN` (default `http://localhost:5173`). `corten check` runs the formatter, clippy and the tests; tests that need the dev database or the Node app's recorded answers are ignored and run with `cargo test -- --ignored`.

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
The Docker dev stack also loads `.env.development.local`, so EasyPost stays on
the test API there.

## Database Commands

Apply migrations:

```bash
npm run db:migrate
```

The Corten server applies the same files the same way before it listens when `MIGRATE_ON_START` is set. It stays unset while the Node app applies them as it starts.

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
The production Docker stack reads `.env.production.local`, so production uses
the live EasyPost API on deploy.

The Corten app answers only to `localhost`, IP addresses and the names listed in `HOSTS`; any other `Host` gets 421. When the app is reached by a name (`automation.lan`, or a reverse proxy that terminates HTTPS such as Tailscale Serve at `https://<machine>.<tailnet>.ts.net` proxying to `http://localhost:3001`), list it in `.env.production.local` (`HOSTS=automation.lan,.ts.net`; a leading dot takes every subdomain) and restart. The Node app's JSON routes still check a post's origin against `allowedActionOrigins` in `react-router.config.ts`.

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

- Host app server: `npm run dev`, then `corten dev --port 3000` for the screens
- Full Docker dev stack: `npm run dev:docker`
- Production stack: `npm run prod:deploy`
- Standalone dev database: `docker compose -f docker-compose.db.yml up -d`

The cleanup removes containers and the old shared network only. Your named Docker volumes, including the PostgreSQL data volumes, are preserved. If the old network is already gone, Docker may print an error that you can ignore.
