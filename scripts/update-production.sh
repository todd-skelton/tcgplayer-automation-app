#!/bin/bash
# Quick update script for production deployment

set -e

echo "Updating production deployment..."

# Check if production container exists
if ! docker ps -a | grep -q "tcgplayer-automation-prod"; then
    echo "No existing production container found. Run deploy-production.sh first."
    exit 1
fi

# Rebuild and restart
echo "Rebuilding production image..."
docker compose -f docker-compose.prod.yml build

echo "Restarting production container..."
docker compose -f docker-compose.prod.yml up -d

echo "Waiting for restart..."
sleep 5

if docker ps | grep -q "tcgplayer-automation-prod"; then
    echo "Production updated successfully!"
    echo "Production app is running at: http://localhost:3001"
else
    echo "Production update failed!"
    echo "Check logs: docker compose -f docker-compose.prod.yml logs"
    exit 1
fi
