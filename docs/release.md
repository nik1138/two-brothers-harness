# Release runbook — `@two-brothers/harness`

How the package ships to npm. **Status: pre-release.** As of this writing the
package is **not on npm** — `@two-brothers/harness` does not exist on the
public registry and the `@two-brothers` scope has no public org page. Nothing
below has happened yet; this is the exact checklist for the owner.

Mechanics live in `.github/workflows/publish.yml` — read its header comment
first; it documents the same one-time setup inline. Pushing a `v*` tag (or
running the workflow by hand) executes the release gate — typecheck, build,
in-process + spawned tests, hermetic CLI E2E, real-socket fault injection, web
unit tests + build, selftest, `pack:check`, and a tag↔version check — and then
publishes with `npm publish --tag next --provenance`. A `v*` tag whose version
does not match `packages/harness/package.json` fails before publishing.
Releases land on the **`next`** dist-tag, never `latest`, until explicitly
promoted below.

## Pre-push release-candidate rehearsal

Run from a clean `main` on Windows with Git Bash first on `PATH` and
`TEMP`/`TMP` pointing at the checkout's `.tmp` (the documented Vite
workaround).

1. `git status --short` is empty and `git log -1 --oneline` is the intended
   commit.
2. Run the one-command rehearsal from the repo root (Windows PowerShell 5.1;
   it prepends Git Bash and points `TEMP`/`TMP` at the checkout's `.tmp`
   itself):

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/release-rehearsal.ps1
   ```

   It runs the checklist below in order, prints a PASS/FAIL line with timings
   per step plus a summary table, and ends with
   `RELEASE REHEARSAL: PASS (7/7)`; any child non-zero exit stops it with the
   captured output tail and exit 1: clean tree → candidate build +
   `npm run check` → `scripts/smoke-test.ps1` (`SMOKE TEST: PASS`) →
   `node scripts/tarball-smoke.mjs` (`TARBALL SMOKE: PASS (7/7)`) and
   `npm run pack:check` → `scripts/e2e-test.ps1` (18 PASS / 0 FAIL / 1 SKIP;
   needs system Edge, not run in CI) → final clean-tree check.

   Fast iterations: `-SkipBrowser` (skip the system-Edge pass) and
   `-SkipTarball` (skip tarball smoke + pack:check); a release candidate
   needs the full run. The manual steps below remain the fallback when one
   step must be run alone.

3. Push and confirm CI green on the ubuntu Node 22/24 matrix and the
   `windows-latest` Node 24 leg.
4. Only then follow the publishing checklist below (tag + workflow).

## One-time external setup (owner, ~15 minutes, no repo changes)

1. **Create the free `@two-brothers` org** at <https://www.npmjs.com/org/create>
   (npm orgs are free; you are only asked for a scope name and billing details
   are not required for a free org). As of 2026-11-04 the name showed no
   public org page and `npm view @two-brothers/harness` returned 404 — confirm
   availability in the org-creation form; if it is taken, rename the package
   scope in `packages/harness/package.json` first (a manifest change that
   needs a matching lockfile refresh).
2. **Link Trusted Publisher.** The package's first publish cannot go through
   OIDC, so create the package entry first: in the org view on npmjs.com use
   **"Create a package" / Provenance (Trusted Publisher) UI** and add a
   GitHub Actions trusted publisher with:
   - Organization: `nik1138` (the GitHub user owning the repo)
   - Repository: `two-brothers-harness`
   - Workflow filename: `publish.yml`
   - Environment: *(leave blank — the workflow uses no GitHub environment)*

   This both creates the empty package placeholder and wires the OIDC link, so
   the workflow can take over from the very first real publish. Alternative:
   publish once manually from a machine with a scope-member token
   (`npm login`, then `npm publish --tag next` in `packages/harness/`), then
   attach the Trusted Publisher on the package's Settings page — but the
   placeholder route keeps everything in CI.

## Publishing 0.0.1 (this first release)

**Use Actions → publish → Run workflow on final `main`** — the `workflow_dispatch`
path runs the identical gate + publish without any tag involvement.

Do **not** reuse the existing `v0.0.1` tag blindly: it points at `157c952` and
predates the redesign (`28883fc`) and the CLI diagnostics and ergonomics
milestone on top of it, so a tag-triggered run would publish stale sources.
Deliberately moving the tag
(`git tag -f v0.0.1 <current-main> && git push -f origin v0.0.1`, with the
commit you intend to publish) so future tag pushes line up with the released
commit is a separate owner decision — only after the npm setup above is
complete, and only if you accept rewriting the remote tag.

For releases after 0.0.1 the generic flow is: bump `version` in
`packages/harness/package.json`, merge to `main`, then
`git tag vX.Y.Z && git push origin vX.Y.Z` — the tag push triggers this same
workflow.

Whatever the trigger:
1. The workflow upgrades to npm ≥ 11.5.1 itself (Trusted Publisher OIDC
   requires it; Node 22 still ships npm 10) — no local toolchain changes.
2. Confirm success: the run ends with the package on the `next` tag.

## Verify the published package (any machine, Node ≥ 22.19)

```bash
npm install -g @two-brothers/harness@next
two-brothers --version
two-brothers run "Plan a migration from Redis to Valkey" --provider mock
two-brothers serve --port 8600   # http://127.0.0.1:8600 serves the packaged web UI
```

Expected: `--version` prints `0.0.1`; the mock run prints a decision with the
compact `tokens … in / … out` usage footer and exits 0; `serve` serves the
built Vue workspace from the tarball (no separate frontend build).

## Promote to `latest` and drop the pre-release notes

When `@next` has soaked and you are ready to make it the default install:

```bash
npm dist-tag add @two-brothers/harness@0.0.1 latest
npm install -g @two-brothers/harness   # no tag = latest
```

Then remove the stale "not on npm yet" notes: the `> **Pre-release:**` block
in `packages/harness/README.md` and the matching note in the root `README.md`
(in the Install section). Do this **after** the package is actually
installable, so the docs never claim availability early.
