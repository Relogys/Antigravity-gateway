param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$Repo = "Relogys/Antigravity-gateway"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js >= 22 is required. Install from https://nodejs.org/"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required (bundled with Node.js)."
}

$NodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) {
    throw "Node.js >= 22 is required (found $(node -v))."
}

$Tag = $Version.Trim()
if (-not $Tag) {
    Write-Host "Resolving latest release from github.com/$Repo ..."
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "antigravity-gateway-installer" }
    $Tag = $Release.tag_name
}
if (-not $Tag.StartsWith("v")) {
    $Tag = "v$Tag"
}

$Ver = $Tag.Substring(1)
$Tarball = "antigravity-gateway-$Ver.tgz"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-gw-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    $TarballPath = Join-Path $TmpDir $Tarball
    $SumsPath = Join-Path $TmpDir "SHA256SUMS.txt"

    Write-Host "Downloading $Tarball and SHA256SUMS.txt ($Tag)..."
    Invoke-WebRequest -Uri "$BaseUrl/$Tarball" -OutFile $TarballPath -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $SumsPath -UseBasicParsing

    Write-Host "Verifying SHA-256 checksum..."
    $ExpectedLine = Get-Content -Path $SumsPath | Where-Object { $_ -match ([regex]::Escape($Tarball) + "$") } | Select-Object -First 1
    if (-not $ExpectedLine) {
        throw "Could not find checksum entry for $Tarball in SHA256SUMS.txt"
    }
    $ExpectedHash = ($ExpectedLine.Trim() -split "\s+")[0].ToLowerInvariant()
    $ActualHash = (Get-FileHash -Path $TarballPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
        throw "SHA-256 checksum mismatch! Expected $ExpectedHash, got $ActualHash"
    }
    Write-Host "SHA-256 verified: $ActualHash"

    Write-Host "Installing antigravity-gateway ($Tag) globally..."
    & npm install -g $TarballPath
    if ($LASTEXITCODE -ne 0) {
        throw "npm install -g failed with exit code $LASTEXITCODE"
    }

    Write-Host ""
    Write-Host "Installed antigravity-gateway $Tag successfully!"
    Write-Host "Next steps:"
    Write-Host "  antigravity-gateway init            # Interactive setup wizard"
    Write-Host "  antigravity-gateway doctor          # Verify Node, agy, channels & permissions"
    Write-Host "  antigravity-gateway service install # Optional: Windows Task Scheduler autostart"
}
finally {
    Remove-Item -Path $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
