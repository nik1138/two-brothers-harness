#!/usr/bin/env pwsh
# One-shot offline smoke test for the TypeScript package (the only
# implementation) plus the zero-dependency protocol reference and the web
# workspace.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
#
# Runs: packages/harness typecheck -> build -> npm test -> dist selftest ->
# mock run -> hermetic CLI E2E -> real-socket fault injection, the
# typescript/ reference selftest, the web/ unit tests, and the web/ build.
# Everything is offline; no model endpoint or API key is needed.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# The Node zip install is not always on PATH (Git Bash does not inherit it);
# fall back to the known per-user location before giving up.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeDir = Join-Path $HOME "AppData\Local\Programs\nodejs"
    if (Test-Path (Join-Path $nodeDir "node.exe")) {
        $env:PATH = "$nodeDir;$env:PATH"
    } else {
        throw "Node.js not found (need Node >= 22.19 on PATH)"
    }
}
Write-Output "Using Node: $((Get-Command node).Source) ($(node --version))"

# The package shell suites spawn `bash`. Prefer Git Bash over a WSL bash.exe
# (system32) first on PATH, whose temp-dir handling makes cleanup-only
# assertions fail for environmental reasons. Prepending the Git for Windows
# bin directory makes the documented command self-contained when Git Bash is
# installed; without it the suites still run and docs/testing.md documents the
# prerequisite.
$gitBashDir = "C:\Program Files\Git\bin"
if (Test-Path (Join-Path $gitBashDir "bash.exe")) {
    $env:PATH = "$gitBashDir;$env:PATH"
    Write-Output "Using Git Bash: $(Join-Path $gitBashDir 'bash.exe')"
}

# Run an external command, letting its stderr through without aborting on it,
# and throw on a non-zero exit code.
#
# NOTE: PowerShell's `& @array` splat does NOT expand for native executables
# (it stringifies them into one name). Pass the exe and the remaining args as
# separate variables instead.
function Run-External([string]$label, [Parameter(ValueFromRemainingArguments = $true)][object[]]$command) {
    $cmd = @($command)
    $exe = $cmd[0]
    $rest = @()
    if ($cmd.Count -gt 1) { $rest = @($cmd[1..($cmd.Count - 1)]) }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $exe $rest
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    if ($code -ne 0) { throw "$label failed (exit $code)" }
}

function Section([string]$name) {
    Write-Output ""
    Write-Output "===== $name ====="
}

$pkg = Join-Path $root "packages\harness"
$ref = Join-Path $root "typescript"
$web = Join-Path $root "web"

Section "Package: typecheck"
Push-Location $pkg
Run-External "npm run typecheck" "npm.cmd" "run" "typecheck"
Pop-Location

Section "Package: build"
Push-Location $pkg
Run-External "npm run build" "npm.cmd" "run" "build"
Pop-Location

Section "Package: tests"
Push-Location $pkg
Run-External "npm test" "npm.cmd" "test"
Pop-Location

Section "Package: selftest"
Push-Location $pkg
Run-External "dist selftest" "node" "dist/selftest.js"
Pop-Location

Section "Demo (mock provider)"
Push-Location $pkg
Run-External "mock run" "node" "dist/cli.js" "run" "Plan a migration from Redis to Valkey" "--provider" "mock"
Pop-Location

Section "Package: hermetic CLI E2E"
Push-Location $pkg
Run-External "cli e2e" "node" "e2e/cli.ts"
Pop-Location

Section "Package: real-socket fault injection"
Push-Location $pkg
Run-External "faults e2e" "node" "e2e/faults.ts"
Pop-Location

Section "Protocol reference: selftest"
Push-Location $ref
Run-External "reference selftest" "node" "src/selftest.ts"
Pop-Location

Section "Web workspace: tests"
Push-Location $web
Run-External "web tests" "npm.cmd" "test"
Pop-Location

Section "Web workspace: build"
Push-Location $web
Run-External "web build" "npm.cmd" "run" "build"
Pop-Location

Write-Output ""
Write-Output "SMOKE TEST: PASS"