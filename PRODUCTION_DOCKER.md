# Production Docker Deployment

The production stack runs the app and PostgreSQL together. The app container waits for the database, applies SQL migrations during startup, and can import the legacy NeDB files from the mounted `data/` directory.

## Quick Start

Deploy the production stack:

```bash
npm run prod:deploy
```

The guarded `npm run prod:*` commands are the supported production entrypoints when you want source enforcement. `prod:deploy`, `prod:update`, `prod:start`, and `prod:restart` fetch `origin/master` and refuse to run unless the local checkout is clean and `HEAD` exactly matches `origin/master`.

This starts:

- The app on `http://localhost:3001`
- PostgreSQL in a sidecar container
- Persistent database storage in the `postgres-data` Docker volume

The production compose file uses the explicit project name `tcgplayer-automation-prod`, so it can run beside the full dev stack `tcgplayer-automation-dev` and the standalone dev database `tcgplayer-automation-db` without sharing Docker networks.

Docker may show the built image name as `tcgplayer-automation-app-app`. That is only the generated image name. The Compose project name for the production stack is still `tcgplayer-automation-prod`.

## Configuration

The production compose file sets:

```bash
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/tcgplayer_automation
```

Optional startup flags:

```bash
DB_STARTUP_RETRIES=30
DB_STARTUP_DELAY_MS=2000
DB_IMPORT_ON_START=false
```

`DB_IMPORT_ON_START` is off by default. Import manually when you want to migrate the checked-in NeDB source files.

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
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml ps
```

Direct `docker compose` commands bypass the source guard. Use the `npm run prod:*` wrappers if you need the `origin/master` enforcement.

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
docker compose -f docker-compose.prod.yml run --rm app npm run db:migrate
```

Import the legacy NeDB files:

```bash
docker compose -f docker-compose.prod.yml run --rm app npm run db:import
```

## Persistence

- PostgreSQL data is stored in the named Docker volume `postgres-data`.
- Legacy `.db` files remain available through the mounted `./data` directory.
- Application logs are mounted to `./logs`.

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
