$ErrorActionPreference = "Stop"

$TaskName = "AntigravityGateway"
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if (-not $Existing) {
    Write-Host "Scheduled task '$TaskName' is not installed."
    exit 0
}

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {
    # Ignore if not running
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Unregistered scheduled task '$TaskName'."
