@echo off
setlocal

set "current_branch="
set "local_head="
set "remote_master="
set "repo_dirty="

for /f "usebackq delims=" %%I in (`git branch --show-current 2^>nul`) do (
    set "current_branch=%%I"
)

echo Checking production source against origin/master...
git fetch origin master
if errorlevel 1 (
    echo.
    echo Production deployment blocked: failed to fetch origin/master.
    echo Verify network access and that the origin remote is available, then try again.
    exit /b 1
)

for /f "usebackq delims=" %%I in (`git rev-parse HEAD 2^>nul`) do (
    set "local_head=%%I"
)

for /f "usebackq delims=" %%I in (`git rev-parse origin/master 2^>nul`) do (
    set "remote_master=%%I"
)

if not defined local_head (
    echo.
    echo Production deployment blocked: could not determine the local HEAD commit.
    exit /b 1
)

if not defined remote_master (
    echo.
    echo Production deployment blocked: could not determine the origin/master commit.
    exit /b 1
)

for /f "usebackq delims=" %%I in (`git status --porcelain`) do (
    if not defined repo_dirty set "repo_dirty=1"
)

if defined current_branch (
    echo Current branch: %current_branch%
) else (
    echo Current branch: [detached HEAD]
)
echo Local HEAD: %local_head%
echo origin/master: %remote_master%

if defined repo_dirty (
    echo.
    echo Production deployment blocked: the working tree has uncommitted changes.
    echo Recovery:
    echo   git status
    echo   git stash push --include-untracked
    echo   git checkout master
    echo   git pull --ff-only origin master
    exit /b 1
)

if /I not "%local_head%"=="%remote_master%" (
    echo.
    echo Production deployment blocked: local HEAD does not match origin/master.
    echo Recovery:
    echo   git fetch origin master
    echo   git checkout master
    echo   git pull --ff-only origin master
    exit /b 1
)

echo Production source check passed.
exit /b 0
