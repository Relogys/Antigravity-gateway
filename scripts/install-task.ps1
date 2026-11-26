$ErrorActionPreference = "Stop"

$TaskName = "AntigravityGateway"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-gateway.ps1"

if (-not (Test-Path $StartScript)) {
    throw "Start script not found: $StartScript"
}

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`"" `
    -WorkingDirectory $RepoRoot

$Trigger = New-ScheduledTaskTrigger -AtLogOn

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "Antigravity iMessage (Photon Spectrum) Gateway" `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (AtLogOn, hidden window, restart on failure)."
Write-Host "To start now: Start-ScheduledTask -TaskName '$TaskName'"
