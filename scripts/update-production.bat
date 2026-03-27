@echo off
REM Quick update script for production deployment

call "%~dp0assert-production-source.bat"
if %errorlevel% neq 0 (
    exit /b 1
)

echo Updating production deployment...

REM Check if production container exists
docker ps -a | findstr "tcgplayer-automation-prod" >nul
if %errorlevel% neq 0 (
    echo No existing production container found. Run deploy-production.bat first.
    exit /b 1
)

REM Rebuild and restart
echo Rebuilding production image...
docker-compose -f docker-compose.prod.yml build

if %errorlevel% neq 0 (
    echo Build failed!
    exit /b 1
)

echo Restarting production container...
docker-compose -f docker-compose.prod.yml up -d

if %errorlevel% neq 0 (
    echo Restart failed!
    exit /b 1
)

echo Waiting for restart...
ping 127.0.0.1 -n 6 > nul

docker ps | findstr "tcgplayer-automation-prod" >nul
if %errorlevel% equ 0 (
    echo Production updated successfully!
    echo Production app is running at: http://localhost:3001
) else (
    echo Production update failed!
    echo Check logs: docker-compose -f docker-compose.prod.yml logs
    exit /b 1
)
