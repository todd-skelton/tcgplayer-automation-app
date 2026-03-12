# Production Docker Deployment

The production stack runs the app and PostgreSQL together. The app container waits for the database, applies SQL migrations during startup, and can import the legacy NeDB files from the mounted `data/` directory.

## Quick Start

Deploy the production stack:

```bash
npm run prod:deploy
```

This starts:

- The app on `http://localhost:3001`
- PostgreSQL in a sidecar container
- Persistent database storage in the `postgres-data` Docker volume

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

Direct Docker Compose commands:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml logs -f
docker compose -f docker-compose.prod.yml ps
```

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
