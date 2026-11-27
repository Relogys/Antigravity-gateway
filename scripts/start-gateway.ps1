param(
    [switch]$OneShot
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$LogsDir = Join-Path $RepoRoot "logs"
if (-not (Test-Path -LiteralPath $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

$GatewayLog = Join-Path $LogsDir "gateway.log"
$SupervisorLog = Join-Path $LogsDir "supervisor.log"
$DistEntry = Join-Path $RepoRoot "dist\index.js"

if (-not (Test-Path -LiteralPath $DistEntry)) {
    Write-Host "Building Antigravity Gateway..."
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

function Write-SupervisorLog {
    param([string]$Message)
    $Line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
    Add-Content -LiteralPath $SupervisorLog -Value $Line -Encoding utf8
}

function Rotate-GatewayLog {
    if (-not (Test-Path -LiteralPath $GatewayLog)) {
        return
    }
    $Length = (Get-Item -LiteralPath $GatewayLog).Length
    if ($Length -le 5MB) {
        return
    }
    $Oldest = "$GatewayLog.3"
    if (Test-Path -LiteralPath $Oldest) {
        Remove-Item -LiteralPath $Oldest -Force
    }
    for ($i = 2; $i -ge 1; $i--) {
        $Source = "$GatewayLog.$i"
        if (Test-Path -LiteralPath $Source) {
            Move-Item -LiteralPath $Source -Destination "$GatewayLog.$($i + 1)" -Force
        }
    }
    Move-Item -LiteralPath $GatewayLog -Destination "$GatewayLog.1" -Force
    Write-SupervisorLog "Rotated gateway.log (exceeded 5MB)."
}

$NodeExe = (Get-Command node -ErrorAction Stop).Source

$RawDataDir = $null
if (-not [string]::IsNullOrWhiteSpace($env:DATA_DIR)) {
    $RawDataDir = $env:DATA_DIR.Trim()
} else {
    $EnvFile = Join-Path $RepoRoot ".env"
    if (Test-Path -LiteralPath $EnvFile) {
        foreach ($Line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
            $Trimmed = $Line.Trim()
            if (-not $Trimmed -or $Trimmed.StartsWith("#")) {
                continue
            }
            if ($Trimmed -match '^(?:export\s+)?DATA_DIR\s*=\s*(.*)$') {
                $Candidate = $Matches[1].Trim()
                if (($Candidate.StartsWith('"') -and $Candidate.EndsWith('"') -and $Candidate.Length -ge 2) -or
                    ($Candidate.StartsWith("'") -and $Candidate.EndsWith("'") -and $Candidate.Length -ge 2)) {
                    $Candidate = $Candidate.Substring(1, $Candidate.Length - 2)
                } else {
                    $Candidate = ($Candidate -replace '\s+#.*$', '').Trim()
                }
                if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
                    $RawDataDir = $Candidate
                }
            }
        }
    }
}

if ([string]::IsNullOrWhiteSpace($RawDataDir)) {
    $DataDir = Join-Path $RepoRoot "data"
} elseif ([System.IO.Path]::IsPathRooted($RawDataDir)) {
    $DataDir = $RawDataDir
} else {
    $DataDir = [System.IO.Path]::GetFullPath((Join-Path $RepoRoot $RawDataDir))
}

$CleanShutdownSentinel = Join-Path $DataDir ".clean_shutdown"

$Delay = 2
while ($true) {
    Rotate-GatewayLog
    Write-SupervisorLog "Launching: $NodeExe $DistEntry"
    Write-Host "Launching gateway (logs: $GatewayLog)"

    $StartedAt = Get-Date
    $ExitCode = 0
    try {
        $CmdArgs = "/d /c `"`"$NodeExe`" `"$DistEntry`" >> `"$GatewayLog`" 2>&1`""
        $Proc = Start-Process -FilePath "cmd.exe" -ArgumentList $CmdArgs -WorkingDirectory $RepoRoot -NoNewWindow -Wait -PassThru
        $ExitCode = $Proc.ExitCode
    }
    catch {
        Write-SupervisorLog ("Launcher error: {0}" -f $_.Exception.Message)
        $ExitCode = 1
    }
    $RanSeconds = ((Get-Date) - $StartedAt).TotalSeconds

    if ($ExitCode -eq 0 -or (Test-Path -LiteralPath $CleanShutdownSentinel)) {
        Write-SupervisorLog ("Gateway stopped cleanly after {0:N0}s (exit={1})." -f $RanSeconds, $ExitCode)
        Write-Host "Gateway exited cleanly."
        exit 0
    }

    Write-SupervisorLog ("Gateway crashed with exit code {0} after {1:N1}s." -f $ExitCode, $RanSeconds)
    if ($OneShot) {
        Write-SupervisorLog "OneShot set; exiting without restart."
        Write-Host "Gateway crashed (exit code $ExitCode); OneShot set, not restarting."
        exit $ExitCode
    }

    if ($RanSeconds -gt 60) {
        $Delay = 2
    }
    Write-SupervisorLog ("Restarting in {0}s." -f $Delay)
    Write-Host "Gateway crashed (exit code $ExitCode); restarting in $Delay s..."
    Start-Sleep -Seconds $Delay
    $Delay = [Math]::Min($Delay * 2, 60)
}