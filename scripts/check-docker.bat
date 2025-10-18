@echo off
REM Docker status and setup check

echo 🔍 Checking Docker setup...

REM Check if Docker is installed
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker is not installed or not in PATH
    echo 📥 Please install Docker Desktop from: https://www.docker.com/products/docker-desktop
    exit /b 1
)

echo ✅ Docker is installed
docker --version

REM Check if Docker daemon is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker daemon is not running
    echo 🚀 Please start Docker Desktop and try again
    echo.
    echo 💡 After starting Docker Desktop:
    echo    1. Wait for Docker to fully start (whale icon in system tray)
    echo    2. Run: npm run prod:deploy
    exit /b 1
)

echo ✅ Docker daemon is running
echo 📊 Docker system info:
docker info --format "table {{.ServerVersion}}\t{{.OSType}}\t{{.Architecture}}"

echo.
echo 🎉 Docker is ready! You can now run:
echo    npm run prod:deploy