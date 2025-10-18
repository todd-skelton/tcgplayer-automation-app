# Production Docker Deployment

This guide explains how to run a stable production version of the TCGPlayer Automation App locally using Docker.

## Quick Start

### Initial Deployment

```bash
# Deploy production for the first time
npm run prod:deploy
```

This will:

- Build a production Docker image
- Start the container on port 3001
- Mount your `data` directory for persistence
- Set up health checks and auto-restart

### Access Your Applications

- **Production (Stable)**: http://localhost:3001
- **Development**: http://localhost:5173 (when running `npm run dev`)

## Available Commands

### NPM Scripts

```bash
# Deployment
npm run prod:deploy    # Initial deployment (builds and starts)
npm run prod:update    # Update existing production (rebuild and restart)

# Management
npm run prod:start     # Start production container
npm run prod:stop      # Stop production container
npm run prod:restart   # Restart production container

# Monitoring
npm run prod:status    # Show container status
npm run prod:logs      # View production logs (follow mode)
npm run prod:shell     # Connect to production container shell

# Cleanup
npm run prod:clean     # Stop and clean up containers/images
```

### Direct Docker Commands

```bash
# Start production
docker-compose -f docker-compose.prod.yml up -d

# Stop production
docker-compose -f docker-compose.prod.yml down

# View logs
docker-compose -f docker-compose.prod.yml logs -f

# Rebuild and restart
docker-compose -f docker-compose.prod.yml up -d --build
```

## Workflow

### Daily Development Workflow

1. **Start production once**: `npm run prod:deploy`
2. **Use production daily**: Navigate to http://localhost:3001
3. **Develop new features**: Run `npm run dev` and work on http://localhost:5173
4. **Update production**: When ready, run `npm run prod:update`

### Data Management

- Your `data` directory is mounted to the production container
- Both development and production share the same data
- Logs are stored in the `logs` directory

### Monitoring Production

```bash
# Check if production is running
npm run prod:status

# Watch production logs in real-time
npm run prod:logs

# Connect to production container for debugging
npm run prod:shell
```

## Features

- **Isolation**: Production runs in a separate container
- **Persistence**: Data directory is mounted for data persistence
- **Health Checks**: Automatic health monitoring
- **Auto-restart**: Container restarts if it crashes
- **Logging**: Centralized logging to `logs` directory
- **Port Separation**: Production (3001) vs Development (5173)

## Troubleshooting

### Container Won't Start

```bash
# Check container status
npm run prod:status

# View detailed logs
npm run prod:logs

# Rebuild from scratch
npm run prod:clean
npm run prod:deploy
```

### Port Conflicts

If port 3001 is in use, edit `docker-compose.prod.yml`:

```yaml
ports:
  - "3002:3000" # Change 3001 to any available port
```

### Memory Issues

If you see memory errors during build:

```bash
# Clean up Docker cache
docker system prune -f

# Then rebuild
npm run prod:deploy
```

### Data Issues

- Data is shared between dev and production via volume mount
- To reset data: stop production, delete `data` directory, restart
- To backup data: copy the `data` directory to a safe location

## Technical Details

### Docker Architecture

- **Multi-stage build**: Optimized for production
- **Alpine Linux**: Lightweight base image
- **Node.js 20**: Latest LTS version
- **Health checks**: Ensures container is responding
- **Volume mounts**: Persistent data and logs

### Environment Variables

- `NODE_ENV=production`
- `PORT=3000` (internal container port)
- `NODE_OPTIONS=--max-old-space-size=16384` (from package.json)

### Security

- Container runs as non-root user
- Only necessary ports exposed
- Production dependencies only
