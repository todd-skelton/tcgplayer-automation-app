@echo off
REM Production deployment script for TCGPlayer Automation App

echo 🚀 Starting production deployment...

REM Create logs directory if it doesn't exist
if not exist logs mkdir logs

REM Check if production container is already running
docker ps | findstr "tcgplayer-automation-prod" >nul
if %errorlevel% equ 0 (
    echo 📦 Stopping existing production container...
    docker-compose -f docker-compose.prod.yml down
)

REM Build and start production container
echo 🔨 Building production image...
docker-compose -f docker-compose.prod.yml build --no-cache

if %errorlevel% neq 0 (
    echo ❌ Build failed!
    exit /b 1
)

echo 🏃 Starting production container...
docker-compose -f docker-compose.prod.yml up -d

if %errorlevel% neq 0 (
    echo ❌ Failed to start container!
    exit /b 1
)

REM Wait for container to be healthy
echo ⏳ Waiting for application to start...
ping 127.0.0.1 -n 11 > nul

REM Check if container is running
docker ps | findstr "tcgplayer-automation-prod" >nul
if %errorlevel% equ 0 (
    echo ✅ Production deployment successful!
    echo.
    echo 🌐 Production app is running at: http://localhost:3001
    echo 📊 Container status: docker ps ^| findstr tcgplayer-automation-prod
    echo 📋 View logs: docker-compose -f docker-compose.prod.yml logs -f
    echo 🛑 Stop production: docker-compose -f docker-compose.prod.yml down
    echo.
    echo 💡 Development can still run on: http://localhost:5173 ^(npm run dev^)
) else (
    echo ❌ Production deployment failed!
    echo 📋 Check logs: docker-compose -f docker-compose.prod.yml logs
    exit /b 1
)