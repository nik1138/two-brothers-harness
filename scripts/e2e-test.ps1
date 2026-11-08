# Thin wrapper: build web if needed, install e2e deps, run the E2E suite.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

# 1. build web/ when dist is missing or older than any source/config file
$distIndex = Join-Path $root 'web\dist\index.html'
$needsBuild = -not (Test-Path $distIndex)
if (-not $needsBuild) {
  $distTime = (Get-Item $distIndex).LastWriteTimeUtc
  $inputs = @(
    (Join-Path $root 'web\src'),
    (Join-Path $root 'web\index.html'),
    (Join-Path $root 'web\vite.config.ts'),
    (Join-Path $root 'web\package.json')
  )
  $newer = Get-ChildItem $inputs -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -gt $distTime } |
    Select-Object -First 1
  $needsBuild = $null -ne $newer
}
if ($needsBuild) {
  Write-Host 'web/dist missing or stale — building web/ ...'
  Push-Location (Join-Path $root 'web')
  try {
    npm install
    npm run build
  } finally {
    Pop-Location
  }
}

# 2. install e2e deps if missing
if (-not (Test-Path (Join-Path $root 'e2e\node_modules'))) {
  Write-Host 'installing e2e dependencies ...'
  Push-Location (Join-Path $root 'e2e')
  try {
    npm install
  } finally {
    Pop-Location
  }
}

# 3. pure packaged-web freshness helper tests (hermetic, no browser)
Push-Location (Join-Path $root 'e2e')
try {
  node web-freshness.test.mjs
  $freshCode = $LASTEXITCODE
} finally {
  Pop-Location
}
if ($freshCode -ne 0) { exit $freshCode }

# 4. run the browser suite
Push-Location (Join-Path $root 'e2e')
try {
  node run.mjs
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $code
