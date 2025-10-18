@echo off
REM Production management utility script

set command=%1

if "%command%"=="start" (
    echo 🏃 Starting production...
    docker-compose -f docker-compose.prod.yml up -d
    echo ✅ Production started at http://localhost:3001
    goto :eof
)

if "%command%"=="stop" (
    echo 🛑 Stopping production...
    docker-compose -f docker-compose.prod.yml down
    echo ✅ Production stopped
    goto :eof
)

if "%command%"=="restart" (
    echo 🔄 Restarting production...
    docker-compose -f docker-compose.prod.yml restart
    echo ✅ Production restarted
    goto :eof
)

if "%command%"=="logs" (
    echo 📋 Showing production logs...
    docker-compose -f docker-compose.prod.yml logs -f
    goto :eof
)

if "%command%"=="status" (
    echo 📊 Production status:
    docker-compose -f docker-compose.prod.yml ps
    goto :eof
)

if "%command%"=="shell" (
    echo 🐚 Connecting to production container...
    docker exec -it tcgplayer-automation-prod sh
    goto :eof
)

if "%command%"=="clean" (
    echo 🧹 Cleaning up production containers and images...
    docker-compose -f docker-compose.prod.yml down
    docker image prune -f
    echo ✅ Cleanup complete
    goto :eof
)

REM Default help message
echo TCGPlayer Automation - Production Management
echo.
echo Usage: %0 [command]
echo.
echo Commands:
echo   start     Start production container
echo   stop      Stop production container
echo   restart   Restart production container
echo   logs      View production logs (follow mode)
echo   status    Show container status
echo   shell     Connect to production container shell
echo   clean     Clean up containers and unused images
echo.
echo Examples:
echo   %0 start
echo   %0 logs
echo   %0 status