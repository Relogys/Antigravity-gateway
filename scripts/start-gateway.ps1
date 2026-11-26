$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$LogsDir = Join-Path $RepoRoot "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

$DistEntry = Join-Path $RepoRoot "dist\index.js"
if (-not (Test-Path $DistEntry)) {
    Write-Host "Building Antigravity Gateway..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

& node $DistEntry
exit $LASTEXITCODE
