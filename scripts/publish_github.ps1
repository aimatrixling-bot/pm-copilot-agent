# publish_github.ps1 — Windows GitHub Release & Update Manifest Publisher
# Usage: .\scripts\publish_github.ps1
# Prerequisites: TAURI_SIGNING_PRIVATE_KEY set in .env, gh CLI authenticated

param()

$ErrorActionPreference = "Continue"
$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $ProjectDir

# ── Colors ──
function Write-Step($msg) { Write-Host "`n[C] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERR $msg" -ForegroundColor Red }

# ── Helper: run external command, stream output, fail on non-zero exit ──
function Invoke-Checked([string]$Name, [scriptblock]$Block) {
    & @Block 2>&1 | ForEach-Object { Write-Host "  $_" }
    if ($LASTEXITCODE -ne 0) { Write-Err "$Name failed (exit code $LASTEXITCODE)"; exit 1 }
}

# ── 1. Load .env ──
Write-Step "Loading .env..."
$envFile = Join-Path $ProjectDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z_0-9]*)\s*=\s*"?(.*?)"?\s*$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
    Write-Ok "Loaded .env"
} else {
    Write-Err ".env not found at $envFile"
    exit 1
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Err "TAURI_SIGNING_PRIVATE_KEY not set. Add it to .env"
    exit 1
}

# ── 2. Read version ──
Write-Step "Reading version..."
$Version = (Get-Content "package.json" | ConvertFrom-Json).version
Write-Ok "Version: $Version"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Err "Invalid version format: $Version"
    exit 1
}

# ── 3. Build ──
Write-Step "Building server + plugin-bridge..."
& bun build ./src/server/index.ts --outfile=./src-tauri/resources/server-dist.js --target=bun 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Err "Server build failed"; exit 1 }

& bun build ./src/server/plugin-bridge/index.ts --outfile=./src-tauri/resources/plugin-bridge-dist.js --target=bun 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Err "Plugin Bridge build failed"; exit 1 }

$serverDist = Get-Content "src-tauri\resources\server-dist.js" -Raw
if ($serverDist.Length -lt 100) {
    Write-Err "server-dist.js is too small ($($serverDist.Length) bytes) — likely a placeholder"
    exit 1
}
Write-Ok "Server + Plugin Bridge built ($([math]::Round($serverDist.Length / 1KB, 0)) KB)"

Write-Step "Building Tauri app (this takes several minutes)..."
Invoke-Checked "Tauri build" { bun run tauri:build }
Write-Ok "Build complete"

# ── 4. Verify artifacts ──
Write-Step "Verifying build artifacts..."
$BundleDir = Join-Path $ProjectDir "src-tauri\target\release\bundle\nsis"

# NSIS installer (may have spaces in name)
$SetupExe = Get-ChildItem $BundleDir -Filter "*-setup.exe" | Select-Object -First 1
if (-not $SetupExe) {
    Write-Err "No setup.exe found in $BundleDir"
    exit 1
}
Write-Ok "Setup: $($SetupExe.Name) ($([math]::Round($SetupExe.Length / 1MB, 1)) MB)"

# NSIS zip for updater
$NsisZip = Get-ChildItem $BundleDir -Filter "*.nsis.zip" | Select-Object -First 1
if (-not $NsisZip) {
    Write-Err "No .nsis.zip found in $BundleDir"
    exit 1
}
Write-Ok "Update package: $($NsisZip.Name)"

# Signature file
$SigFile = Get-ChildItem $BundleDir -Filter "*.nsis.zip.sig" | Select-Object -First 1
if (-not $SigFile) {
    Write-Err "No .nsis.zip.sig found. TAURI_SIGNING_PRIVATE_KEY may be invalid."
    exit 1
}
$Signature = (Get-Content $SigFile.FullName -Raw).Trim()
Write-Ok "Signature: $($Signature.Substring(0, [math]::Min(30, $Signature.Length)))..."

# ── 5. Create GitHub Release ──
$Tag = "v$Version"
Write-Step "Creating GitHub Release $Tag..."

# Check if release already exists
gh release view $Tag 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Warn "Release $Tag already exists. Deleting and recreating..."
    gh release delete $Tag --yes 2>&1 | Out-Null
    git tag -d $Tag 2>&1 | Out-Null
    git push origin ":refs/tags/$Tag" 2>&1 | Out-Null
}

# Rename files for upload (replace spaces with hyphens)
$UploadSetupName = $SetupExe.Name -replace ' ', '-'
$UploadZipName = $NsisZip.Name -replace ' ', '-'

# Copy with new names to temp location
$TempDir = Join-Path $env:TEMP "pm-copilot-release-$Version"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
Copy-Item $SetupExe.FullName (Join-Path $TempDir $UploadSetupName) -Force
Copy-Item $NsisZip.FullName (Join-Path $TempDir $UploadZipName) -Force

$ReleaseNotes = "PM Copilot v$Version`n`nSee CHANGELOG.md for details."

Invoke-Checked "Create GitHub Release" { gh release create $Tag `
    (Join-Path $TempDir $UploadSetupName) `
    (Join-Path $TempDir $UploadZipName) `
    --title $Tag `
    --notes $ReleaseNotes }
Write-Ok "Release created: https://github.com/aimatrixling-bot/pm-copilot-agent/releases/tag/$Tag"

# Clean temp
Remove-Item $TempDir -Recurse -Force

# ── 6. Update gh-pages manifest ──
Write-Step "Updating gh-pages manifest..."

$DownloadUrl = "https://github.com/aimatrixling-bot/pm-copilot-agent/releases/download/$Tag/$UploadZipName"
$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$Manifest = @{
    version    = $Version
    notes      = "PM Copilot v$Version"
    pub_date   = $PubDate
    signature  = $Signature
    url        = $DownloadUrl
} | ConvertTo-Json -Compress

Write-Host "  Manifest URL: $DownloadUrl"

# Clone gh-pages, update manifest, push
$GhPagesDir = Join-Path $env:TEMP "pm-copilot-gh-pages"
if (Test-Path $GhPagesDir) { Remove-Item $GhPagesDir -Recurse -Force }
Invoke-Checked "Clone gh-pages" { git clone --branch gh-pages --single-branch (git remote get-url origin) $GhPagesDir }

$UpdateDir = Join-Path $GhPagesDir "update"
if (-not (Test-Path $UpdateDir)) { New-Item -ItemType Directory -Path $UpdateDir | Out-Null }

$Manifest | Out-File -FilePath (Join-Path $UpdateDir "windows-x86_64.json") -Encoding utf8 -NoNewline

Set-Location $GhPagesDir
git add -A
Invoke-Checked "Commit manifest" { git commit -m "update: v$Version manifest" }
Invoke-Checked "Push gh-pages" { git push origin gh-pages }
Set-Location $ProjectDir

Remove-Item $GhPagesDir -Recurse -Force
Write-Ok "Manifest pushed to gh-pages"

# ── 7. Verify ──
Write-Step "Verifying..."
Start-Sleep -Seconds 5

$ManifestUrl = "https://aimatrixling-bot.github.io/pm-copilot-agent/update/windows-x86_64.json"
try {
    $response = Invoke-WebRequest -Uri $ManifestUrl -TimeoutSec 15 -UseBasicParsing
    $json = $response.Content | ConvertFrom-Json
    if ($json.version -eq $Version) {
        Write-Ok "Manifest accessible: version=$($json.version)"
    } else {
        Write-Warn "Manifest version mismatch: expected=$Version got=$($json.version)"
        Write-Warn "GitHub Pages may need more time to update (usually < 1 min)"
    }
} catch {
    Write-Warn "Could not verify manifest yet: $_"
    Write-Warn "GitHub Pages may need more time to deploy (usually < 1 min)"
}

# ── 8. Clean old build artifacts ──
Write-Step "Cleaning old build artifacts..."
$AllArtifacts = Get-ChildItem $BundleDir -File | Where-Object {
    $_.Name -match '\d+\.\d+\.\d+' -and
    $_.Name -notmatch [regex]::Escape($Version)
}
$Cleaned = 0
foreach ($artifact in $AllArtifacts) {
    Remove-Item $artifact.FullName -Force
    Write-Host "  DEL $($artifact.Name)" -ForegroundColor DarkGray
    $Cleaned++
}
if ($Cleaned -gt 0) {
    Write-Ok "Cleaned $Cleaned old artifact(s), kept v$Version"
} else {
    Write-Ok "No old artifacts to clean"
}

# ── Done ──
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Release v$Version published!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Release:  https://github.com/aimatrixling-bot/pm-copilot-agent/releases/tag/$Tag"
Write-Host "  Manifest: $ManifestUrl"
Write-Host ""
