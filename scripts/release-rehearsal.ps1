<#
.SYNOPSIS
Runs the pre-push release-candidate rehearsal for Two Brothers with one command.

.DESCRIPTION
Executes the manual checklist in docs/release.md ("Pre-push release-candidate
rehearsal") in order, timing every step and printing a PASS/FAIL line plus a
final summary table:

  1. Working tree clean (tracked/untracked files; gitignored files do not count;
     the uncommitted scripts/release-rehearsal.ps1 itself is tolerated so the
     script can rehearse the candidate that adds it).
  2. Build the current sources + root dependency gate (`npm run check`; the
     build first makes the runtime-dependency scan cover the candidate sources
     and lets a never-built checkout pass the gate).
  3. Offline smoke gate (`scripts/smoke-test.ps1`, ends `SMOKE TEST: PASS`).
  4. Tarball install smoke (`node scripts/tarball-smoke.mjs`,
     `TARBALL SMOKE: PASS (7/7)`) - unless -SkipTarball.
  5. Packaging checks (`npm run pack:check` in packages/harness) - unless
     -SkipTarball.
  6. Browser E2E (`scripts/e2e-test.ps1`, needs the system Edge browser and
     exits with 0 failures) - unless -SkipBrowser.
  7. Final working-tree check (the rehearsal must not modify tracked files).

The script prepends Git Bash (`C:\Program Files\Git\bin`) to PATH when present
(the package's shell suites spawn `bash`) and points TEMP/TMP at
`<repo>\.tmp` for every child process (the documented Windows Vite workaround).
It never swallows a non-zero exit code: an external command's `$LASTEXITCODE`
is checked, the output tail is printed on failure, and the script exits 1.

This is a Windows PowerShell 5.1 script (no PS7-only syntax). It needs git,
node and npm on PATH. Full run: about 6-12 minutes (smoke + browser E2E
dominate). It is a local pre-push rehearsal; CI runs the same hermetic gates
without the browser pass.

.PARAMETER SkipBrowser
Skip the browser E2E step (step 6). Useful for quick iterations; the browser
step needs the system Edge browser and is the only non-headless-layer gate. A
release candidate should be rehearsed without this flag at least once.

.PARAMETER SkipTarball
Skip the tarball install smoke (step 4) and the packaging checks (step 5).
Useful for quick iterations; a release candidate must pass both.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\release-rehearsal.ps1
Full rehearsal (all steps, including browser E2E and tarball checks).

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\release-rehearsal.ps1 -SkipBrowser
Everything except the browser E2E pass.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\release-rehearsal.ps1 -SkipBrowser -SkipTarball
Fastest iteration loop: clean tree, build + dependency gate, offline smoke, final tree check.

.NOTES
Exit codes: 0 = every planned step passed; 1 = the rehearsal failed (the
failed step and its output tail are printed; later steps are not run).
Step logs are written below <repo>\.tmp\release-rehearsal\ (gitignored).
#>

[CmdletBinding()]
param(
    [switch]$SkipBrowser,
    [switch]$SkipTarball
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------- #
# paths + environment
# --------------------------------------------------------------------------- #

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:SelfRel = 'scripts/release-rehearsal.ps1'
$script:GitBashDir = 'C:\Program Files\Git\bin'
$script:Results = @()
$script:ExitCode = 1

function Fail-Preflight {
    param([string]$Message)
    Write-Host ''
    Write-Host "RELEASE REHEARSAL: FAIL (preflight: $Message)" -ForegroundColor Red
    exit 1
}

foreach ($required in @('package.json', 'packages\harness', 'web', 'scripts\smoke-test.ps1', 'scripts\e2e-test.ps1')) {
    $path = Join-Path $script:RepoRoot $required
    if (-not (Test-Path -LiteralPath $path)) {
        Fail-Preflight "not a Two Brothers checkout (missing $required) - resolved repo root: $script:RepoRoot"
    }
}

$script:NodeExe = $null
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    Fail-Preflight 'node is not on PATH (install Node >= 22.19)'
}
$script:NodeExe = $nodeCommand.Path
if (-not $script:NodeExe) { $script:NodeExe = $nodeCommand.Source }

$script:NpmExe = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
if ($null -eq $npmCommand) {
    Fail-Preflight 'npm is not on PATH'
}
$script:NpmExe = $npmCommand.Path
if (-not $script:NpmExe) { $script:NpmExe = $npmCommand.Source }

$script:GitExe = $null
$gitCommand = Get-Command git -ErrorAction SilentlyContinue
if ($null -eq $gitCommand) {
    Fail-Preflight 'git is not on PATH'
}
$script:GitExe = $gitCommand.Path
if (-not $script:GitExe) { $script:GitExe = $gitCommand.Source }

$script:PowerShellExe = $null
$psCommand = Get-Command powershell.exe -ErrorAction SilentlyContinue
if ($null -eq $psCommand) {
    $script:PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
} else {
    $script:PowerShellExe = $psCommand.Path
}

$script:TempDir = Join-Path $script:RepoRoot '.tmp'
$script:LogDir = Join-Path $script:TempDir 'release-rehearsal'
if (-not (Test-Path -LiteralPath $script:TempDir)) {
    New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $script:LogDir)) {
    New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
}

# Keep the caller's environment to restore it before exiting (harmless for a
# -File run, correct for a dot-sourced run).
$script:SavedPath = $env:PATH
$script:SavedTemp = $env:TEMP
$script:SavedTmp = $env:TMP

# The package's shell suites spawn `bash`; prefer Git Bash over a WSL shim.
$bashExe = Join-Path $script:GitBashDir 'bash.exe'
$gitBashNote = 'not found (shell suites may fail)'
if (Test-Path -LiteralPath $bashExe) {
    $env:PATH = $script:GitBashDir + ';' + $env:PATH
    $gitBashNote = $bashExe
}
# Vite dev/build on this machine needs a temp dir inside the checkout.
$env:TEMP = $script:TempDir
$env:TMP = $script:TempDir

# --------------------------------------------------------------------------- #
# process helpers
# --------------------------------------------------------------------------- #

function Get-LogTail {
    param([string]$LogFile, [int]$Count = 30)
    if (-not (Test-Path -LiteralPath $LogFile)) { return '(no log captured)' }
    $tail = @(Get-Content -LiteralPath $LogFile -Tail $Count -ErrorAction SilentlyContinue)
    return ($tail -join "`n")
}

# Locale-independent "12.3s" formatting (the machine may use a comma decimal
# separator; release evidence should read the same everywhere).
function Format-Seconds {
    param([double]$Seconds)
    return $Seconds.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
}

# Run an external command, stream its output to the host, and persist the full
# output under the gitignored log dir. Returns the child's exit code; callers
# MUST check it (no exit code is ever swallowed).
function Invoke-StreamedProcess {
    param(
        [string]$Exe,
        [string[]]$Arguments,
        [string]$WorkDir,
        [string]$LogFile
    )
    $displayArgs = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    Write-Host ''
    Write-Host ("> {0} {1}" -f $Exe, $displayArgs) -ForegroundColor DarkGray
    Write-Host ("  (cwd: {0})" -f $WorkDir) -ForegroundColor DarkGray
    $lines = New-Object System.Collections.Generic.List[string]
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exitCode = -1
    Push-Location -LiteralPath $WorkDir
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object {
            # Native stderr arrives as ErrorRecord objects; render their real
            # message instead of the generic RemoteException wrapper.
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $text = $_.Exception.Message
            } else {
                $text = "$_"
            }
            [void]$lines.Add($text)
            Write-Host $text
        }
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        Set-Content -LiteralPath $LogFile -Value $lines -Encoding UTF8
        $ErrorActionPreference = $previousPreference
    }
    return $exitCode
}

# Run an external command and capture its output without streaming it (used for
# git probes and short checks).
function Invoke-CapturedProcess {
    param(
        [string]$Exe,
        [string[]]$Arguments,
        [string]$WorkDir
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exitCode = -1
    $lines = @()
    Push-Location -LiteralPath $WorkDir
    try {
        $lines = @(& $Exe @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Lines = $lines }
}

# Check a child exit code; on failure throw with the captured output tail.
function Assert-ExitCode {
    param([int]$ExitCode, [string]$Label, [string]$LogFile)
    if ($ExitCode -ne 0) {
        $tail = Get-LogTail -LogFile $LogFile
        throw ("{0} failed (exit code {1}).`n--- output tail ---`n{2}" -f $Label, $ExitCode, $tail)
    }
}

# Check that a successful child's output carries its expected success marker.
function Assert-Marker {
    param([string]$LogFile, [string]$Pattern, [string]$Label)
    $content = ''
    if (Test-Path -LiteralPath $LogFile) {
        $content = Get-Content -LiteralPath $LogFile -Raw -ErrorAction SilentlyContinue
    }
    if ($content -notmatch $Pattern) {
        $tail = Get-LogTail -LogFile $LogFile
        throw ("{0} succeeded but the expected output /{1}/ was not found.`n--- output tail ---`n{2}" -f $Label, $Pattern, $tail)
    }
}

# --------------------------------------------------------------------------- #
# steps
# --------------------------------------------------------------------------- #

function Step-WorkingTreeClean {
    param([string]$Phase)
    $status = Invoke-CapturedProcess -Exe $script:GitExe -Arguments @('-C', $script:RepoRoot, 'status', '--porcelain', '--untracked-files=normal') -WorkDir $script:RepoRoot
    if ($status.ExitCode -ne 0) {
        throw ("git status failed (exit code {0}): {1}" -f $status.ExitCode, ($status.Lines -join '; '))
    }
    $issues = @()
    foreach ($line in $status.Lines) {
        $trimmed = "$line".TrimEnd()
        if ($trimmed -eq '') { continue }
        # The script under test may itself be uncommitted while it rehearses the
        # candidate that adds it; every other change is an offender.
        if ($trimmed -eq ('?? ' + $script:SelfRel)) { continue }
        $issues += $trimmed
    }
    if ($issues.Count -gt 0) {
        $shown = ($issues | Select-Object -First 10) -join "`n  "
        $message = ("{0}: the working tree is not clean - a release rehearsal must run on the committed tree." +
            "`n  Offenders (git status --porcelain):`n  {1}")
        throw ($message -f $Phase, $shown)
    }
    $head = Invoke-CapturedProcess -Exe $script:GitExe -Arguments @('-C', $script:RepoRoot, 'log', '-1', '--oneline') -WorkDir $script:RepoRoot
    $headLine = (@($head.Lines) | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1)
    return ("{0} clean - HEAD {1}" -f $Phase, $headLine)
}

function Step-DependencyGate {
    $packageDir = Join-Path $script:RepoRoot 'packages\harness'
    $buildLog = Join-Path $script:LogDir '01-build.log'
    $buildCode = Invoke-StreamedProcess -Exe $script:NpmExe -Arguments @('run', 'build') -WorkDir $packageDir -LogFile $buildLog
    Assert-ExitCode -ExitCode $buildCode -Label 'npm run build (packages/harness)' -LogFile $buildLog
    $checkLog = Join-Path $script:LogDir '02-npm-check.log'
    $checkCode = Invoke-StreamedProcess -Exe $script:NpmExe -Arguments @('run', 'check') -WorkDir $script:RepoRoot -LogFile $checkLog
    Assert-ExitCode -ExitCode $checkCode -Label 'npm run check (repo root)' -LogFile $checkLog
    return 'candidate build + pinned-deps/runtime-deps gates PASS'
}

function Step-SmokeGate {
    $smokeScript = Join-Path $script:RepoRoot 'scripts\smoke-test.ps1'
    $log = Join-Path $script:LogDir '03-smoke.log'
    $code = Invoke-StreamedProcess -Exe $script:PowerShellExe -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $smokeScript) -WorkDir $script:RepoRoot -LogFile $log
    Assert-ExitCode -ExitCode $code -Label 'scripts/smoke-test.ps1' -LogFile $log
    Assert-Marker -LogFile $log -Pattern 'SMOKE TEST: PASS' -Label 'scripts/smoke-test.ps1'
    return 'offline smoke gate PASS (SMOKE TEST: PASS)'
}

function Step-TarballSmoke {
    $tarballScript = Join-Path $script:RepoRoot 'scripts\tarball-smoke.mjs'
    $log = Join-Path $script:LogDir '04-tarball-smoke.log'
    $code = Invoke-StreamedProcess -Exe $script:NodeExe -Arguments @($tarballScript) -WorkDir $script:RepoRoot -LogFile $log
    Assert-ExitCode -ExitCode $code -Label 'node scripts/tarball-smoke.mjs' -LogFile $log
    Assert-Marker -LogFile $log -Pattern 'TARBALL SMOKE: PASS \([0-9]+/[0-9]+\)' -Label 'node scripts/tarball-smoke.mjs'
    return 'tarball install smoke PASS'
}

function Step-PackCheck {
    $packageDir = Join-Path $script:RepoRoot 'packages\harness'
    $log = Join-Path $script:LogDir '05-pack-check.log'
    $code = Invoke-StreamedProcess -Exe $script:NpmExe -Arguments @('run', 'pack:check') -WorkDir $packageDir -LogFile $log
    Assert-ExitCode -ExitCode $code -Label 'npm run pack:check (packages/harness)' -LogFile $log
    return 'publint + attw packaging checks PASS'
}

function Step-BrowserE2E {
    Write-Host 'NOTE: this step needs the system Microsoft Edge browser; it is an opt-in/manual layer and CI does not run it.' -ForegroundColor Yellow
    $e2eScript = Join-Path $script:RepoRoot 'scripts\e2e-test.ps1'
    $log = Join-Path $script:LogDir '06-browser-e2e.log'
    $code = Invoke-StreamedProcess -Exe $script:PowerShellExe -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $e2eScript) -WorkDir $script:RepoRoot -LogFile $log
    Assert-ExitCode -ExitCode $code -Label 'scripts/e2e-test.ps1 (browser E2E)' -LogFile $log
    Assert-Marker -LogFile $log -Pattern 'failures:\s*0\b' -Label 'scripts/e2e-test.ps1 (browser E2E)'
    $summary = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
    $match = [regex]::Match($summary, 'total:\s*([0-9.]+)s,\s*failures:\s*0')
    if ($match.Success) {
        return ('browser E2E PASS - 0 failures (suite time {0}s)' -f $match.Groups[1].Value)
    }
    return 'browser E2E PASS - 0 failures'
}

# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #

function Invoke-RehearsalStep {
    param(
        [pscustomobject]$Step,
        [int]$Index,
        [int]$Total
    )
    Write-Host ''
    Write-Host ("=== [{0}/{1}] {2} ===" -f $Index, $Total, $Step.Name) -ForegroundColor Cyan
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $true
    $detail = ''
    try {
        $detail = [string](& $Step.Action)
    } catch {
        $ok = $false
        $detail = $_.Exception.Message
    }
    $stopwatch.Stop()
    $seconds = [math]::Round($stopwatch.Elapsed.TotalSeconds, 1)
    $secondsText = Format-Seconds $seconds
    $script:Results += [pscustomobject]@{
        Index = $Index
        Name = $Step.Name
        Ok = $ok
        Seconds = $seconds
        Detail = $detail
    }
    if ($ok) {
        $line = "PASS [{0}/{1}] {2} ({3}s)" -f $Index, $Total, $Step.Name, $secondsText
        if ($detail -ne '') { $line = $line + ' - ' + $detail }
        Write-Host $line -ForegroundColor Green
    } else {
        Write-Host ("FAIL [{0}/{1}] {2} ({3}s)" -f $Index, $Total, $Step.Name, $secondsText) -ForegroundColor Red
        Write-Host $detail -ForegroundColor Red
    }
    return $ok
}

$totalStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$failingStep = $null
$failingIndex = 0

try {
    $branch = Invoke-CapturedProcess -Exe $script:GitExe -Arguments @('-C', $script:RepoRoot, 'rev-parse', '--abbrev-ref', 'HEAD') -WorkDir $script:RepoRoot
    $branchName = (@($branch.Lines) | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1)
    $nodeVersion = (& $script:NodeExe --version)
    $headProbe = Invoke-CapturedProcess -Exe $script:GitExe -Arguments @('-C', $script:RepoRoot, 'log', '-1', '--oneline') -WorkDir $script:RepoRoot
    $headLine = (@($headProbe.Lines) | Where-Object { "$_".Trim() -ne '' } | Select-Object -First 1)

    $plan = New-Object System.Collections.ArrayList
    [void]$plan.Add([pscustomobject]@{ Name = 'Working tree clean'; Action = { Step-WorkingTreeClean 'initial tree' } })
    [void]$plan.Add([pscustomobject]@{ Name = 'Build + root dependency gate'; Action = { Step-DependencyGate } })
    [void]$plan.Add([pscustomobject]@{ Name = 'Offline smoke gate'; Action = { Step-SmokeGate } })
    if (-not $SkipTarball) {
        [void]$plan.Add([pscustomobject]@{ Name = 'Tarball install smoke'; Action = { Step-TarballSmoke } })
        [void]$plan.Add([pscustomobject]@{ Name = 'Packaging checks (pack:check)'; Action = { Step-PackCheck } })
    }
    if (-not $SkipBrowser) {
        [void]$plan.Add([pscustomobject]@{ Name = 'Browser E2E (system Edge)'; Action = { Step-BrowserE2E } })
    }
    [void]$plan.Add([pscustomobject]@{ Name = 'Final working tree clean'; Action = { Step-WorkingTreeClean 'final tree' } })

    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host ' Two Brothers - release-candidate rehearsal' -ForegroundColor Cyan
    Write-Host '==============================================================' -ForegroundColor Cyan
    Write-Host ("repo:        {0}" -f $script:RepoRoot)
    Write-Host ("HEAD:        {0}" -f $headLine)
    Write-Host ("branch:      {0}" -f $branchName)
    Write-Host ("node:        {0} ({1})" -f $nodeVersion, $script:NodeExe)
    Write-Host ("powershell:  {0}" -f $PSVersionTable.PSVersion.ToString())
    Write-Host ("TEMP/TMP:    {0}" -f $script:TempDir)
    Write-Host ("Git Bash:    {0}" -f $gitBashNote)
    Write-Host ("steps:       {0} (browser E2E: {1}; tarball checks: {2})" -f $plan.Count, $(if ($SkipBrowser) { 'skipped' } else { 'included' }), $(if ($SkipTarball) { 'skipped' } else { 'included' }))
    Write-Host ("logs:        {0}" -f $script:LogDir)
    if ($SkipBrowser -or $SkipTarball) {
        Write-Host 'Note: this is a partial rehearsal (flags were used); a release candidate needs the full run.' -ForegroundColor Yellow
    }

    $total = $plan.Count
    $loopIndex = 0
    foreach ($step in $plan) {
        $loopIndex += 1
        $stepOk = Invoke-RehearsalStep -Step $step -Index $loopIndex -Total $total
        if (-not $stepOk) {
            $failingStep = $step
            $failingIndex = $loopIndex
            break
        }
    }
} catch {
    Write-Host ''
    Write-Host ("RELEASE REHEARSAL: FAIL (unexpected error: {0})" -f $_.Exception.Message) -ForegroundColor Red
    $script:ExitCode = 1
} finally {
    $env:PATH = $script:SavedPath
    $env:TEMP = $script:SavedTemp
    $env:TMP = $script:SavedTmp
}

$totalStopwatch.Stop()
$plannedCount = 0
if ($null -ne $plan) { $plannedCount = $plan.Count }
$passedCount = @($script:Results | Where-Object { $_.Ok }).Count

Write-Host ''
Write-Host '=== rehearsal summary ===' -ForegroundColor Cyan
if ($script:Results.Count -gt 0) {
    Write-Host ("{0,-44} {1,10} {2,8}" -f 'STEP', 'DURATION', 'RESULT')
    foreach ($result in $script:Results) {
        $resultText = if ($result.Ok) { 'PASS' } else { 'FAIL' }
        Write-Host ("{0,-44} {1,9}s {2,8}" -f $result.Name, (Format-Seconds $result.Seconds), $resultText)
    }
}
Write-Host ("total: {0}s ({1}/{2} steps passed)" -f (Format-Seconds $totalStopwatch.Elapsed.TotalSeconds), $passedCount, $plannedCount)

if ($null -ne $failingStep) {
    Write-Host ("RELEASE REHEARSAL: FAIL (step {0}: {1})" -f $failingIndex, $failingStep.Name) -ForegroundColor Red
    Write-Host 'Fix the failing step and re-run; the rehearsal stops at the first failure.' -ForegroundColor Red
    exit 1
}

if ($plannedCount -gt 0 -and $passedCount -eq $plannedCount) {
    Write-Host ("RELEASE REHEARSAL: PASS ({0}/{0})" -f $plannedCount) -ForegroundColor Green
    exit 0
}

Write-Host 'RELEASE REHEARSAL: FAIL (not all planned steps ran)' -ForegroundColor Red
exit 1
