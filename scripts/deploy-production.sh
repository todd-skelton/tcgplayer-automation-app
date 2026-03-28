#!/bin/bash
# Production deployment script for TCGPlayer Automation App

set -e

echo "Starting production deployment..."

# Create logs directory if it doesn't exist
mkdir -p logs

# Check if production container is already running
if docker ps | grep -q "tcgplayer-automation-prod"; then
    echo "Stopping existing production container..."
    docker compose -f docker-compose.prod.yml down
fi

# Build and start production container
echo "Building production image..."
docker compose -f docker-compose.prod.yml build --no-cache

echo "Starting production container..."
docker compose -f docker-compose.prod.yml up -d

# Wait for container to be healthy
echo "Waiting for application to start..."
sleep 10

# Check if container is running
if docker ps | grep -q "tcgplayer-automation-prod"; then
    echo "Production deployment successful!"
    echo ""
    echo "Production app is running at: http://localhost:3001"
    echo "Container status: docker ps | grep tcgplayer-automation-prod"
    echo "View logs: docker compose -f docker-compose.prod.yml logs -f"
    echo "Stop production: docker compose -f docker-compose.prod.yml down"
    echo ""
    echo "Development can still run on: http://localhost:5173 (npm run dev or npm run dev:host)"
else
    echo "Production deployment failed!"
    echo "Check logs: docker compose -f docker-compose.prod.yml logs"
    exit 1
fi
