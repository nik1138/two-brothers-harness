# Thin wrapper: build web if needed, install e2e deps, run the E2E suite.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

# Backend-process safety net. run.mjs reaps its own backend on every exit path
# (pass, FAIL, exception, Ctrl+C/Ctrl+Break, SIGTERM), but a runner that is
# itself force-killed (taskkill /F, Stop-Process) cannot clean up and would
# orphan its `cli.js serve` (plus the scripted fixture server). The finally
# block below sweeps for exactly those processes — and nothing else:
#   - a `cli.js serve` whose command line carries THIS repo's built CLI and
#     whose --sessions-dir lives under this run's E2E temp root
#     (TWO_BROTHERS_E2E_TMP_ROOT or <repo>\.e2e-tmp); a serve started by hand
#     (default sessions dir, another port/checkout, a dev `serve --port 8600`)
#     does not match and stays alive;
#   - this repo's scripted model fixture (e2e\fixtures\scripted-server.mjs).
$e2eTmpRoot = $env:TWO_BROTHERS_E2E_TMP_ROOT
if (-not $e2eTmpRoot) { $e2eTmpRoot = Join-Path $root '.e2e-tmp' }
$e2eTmpRoot = [System.IO.Path]::GetFullPath($e2eTmpRoot)

function Stop-E2EBackendProcesses {
  $cliPath = Join-Path $root 'packages\harness\dist\cli.js'
  $fixturePath = Join-Path $root 'e2e\fixtures\scripted-server.mjs'
  # A matching backend still parented to a LIVE `node run.mjs` belongs to a
  # concurrent in-flight suite in this checkout — never touch it (Windows keeps
  # the dead parent's PID, so a true orphan's parent is NOT a live runner).
  $liveRunnerPids = @{}
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine -match 'run\.mjs["\s]*$'
  } | ForEach-Object { $liveRunnerPids[$_.ProcessId] = $true }
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $cl = $_.CommandLine
    if (-not $cl) { return $false }
    if ($liveRunnerPids.ContainsKey($_.ParentProcessId)) { return $false }
    # normalize separators so a forward-slash command line matches too
    $cl = $cl.Replace('/', '\')
    $isBackend =
      $cl.IndexOf($cliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $cl.IndexOf(' serve ', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $cl.IndexOf($e2eTmpRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $isFixture =
      $cl.IndexOf($fixturePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $isBackend -or $isFixture
  }
  foreach ($proc in $procs) {
    Write-Host "e2e cleanup: stopping orphaned node process $($proc.ProcessId) (tree)"
    taskkill /PID $proc.ProcessId /T /F | Out-Null
  }
}

$exitCode = 1
try {
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

  # 3. pure helper tests (hermetic, no browser): packaged-web freshness +
  #    missing-backend SKIP-registry parity
  Push-Location (Join-Path $root 'e2e')
  try {
    node web-freshness.test.mjs
    $freshCode = $LASTEXITCODE
    if ($freshCode -eq 0) {
      node skip-registry.test.mjs
      $freshCode = $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }
  if ($freshCode -ne 0) { exit $freshCode }

  # 4. run the browser suite
  Push-Location (Join-Path $root 'e2e')
  try {
    node run.mjs
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  # no-op on a clean run (run.mjs already reaped everything); the net for a
  # force-killed or crashed runner
  Stop-E2EBackendProcesses
}
exit $exitCode
