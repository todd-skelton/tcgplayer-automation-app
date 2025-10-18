#!/bin/bash
# Production management utility script

command=$1

case $command in
  "start")
    echo "🏃 Starting production..."
    docker-compose -f docker-compose.prod.yml up -d
    echo "✅ Production started at http://localhost:3001"
    ;;
  "stop")
    echo "🛑 Stopping production..."
    docker-compose -f docker-compose.prod.yml down
    echo "✅ Production stopped"
    ;;
  "restart")
    echo "🔄 Restarting production..."
    docker-compose -f docker-compose.prod.yml restart
    echo "✅ Production restarted"
    ;;
  "logs")
    echo "📋 Showing production logs..."
    docker-compose -f docker-compose.prod.yml logs -f
    ;;
  "status")
    echo "📊 Production status:"
    docker-compose -f docker-compose.prod.yml ps
    ;;
  "shell")
    echo "🐚 Connecting to production container..."
    docker exec -it tcgplayer-automation-prod sh
    ;;
  "clean")
    echo "🧹 Cleaning up production containers and images..."
    docker-compose -f docker-compose.prod.yml down
    docker image prune -f
    echo "✅ Cleanup complete"
    ;;
  *)
    echo "TCGPlayer Automation - Production Management"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  start     Start production container"
    echo "  stop      Stop production container"
    echo "  restart   Restart production container"
    echo "  logs      View production logs (follow mode)"
    echo "  status    Show container status"
    echo "  shell     Connect to production container shell"
    echo "  clean     Clean up containers and unused images"
    echo ""
    echo "Examples:"
    echo "  $0 start"
    echo "  $0 logs"
    echo "  $0 status"
    ;;
esac