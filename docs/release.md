# Release runbook — `@two-brothers/harness`

How the package ships to npm. **Status: 0.0.1 published on the `next`
dist-tag; `latest` still points at the 0.0.0 placeholder.** The publish
workflow ran on `main` with the full gate and signed provenance. Promoting
`0.0.1` to `latest` is the remaining step — see "Promote to `latest`" below.

Mechanics live in `.github/workflows/publish.yml` — read its header comment
first; it documents the same one-time setup inline. Pushing a `v*` tag (or
running the workflow by hand) executes the release gate — typecheck, build,
in-process + spawned tests, hermetic CLI E2E, real-socket fault injection, web
unit tests + build, selftest, `pack:check`, and a tag↔version check — and then
publishes with `npm publish --tag next`. Provenance is automatic under trusted
publishing when the GitHub repository is public; npm does not generate it for
private source repositories, so the workflow does not pass `--provenance`
explicitly. A `v*` tag whose version does not match
`packages/harness/package.json` fails before publishing. Releases land on the
**`next`** dist-tag, never `latest`, until explicitly promoted below.

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
   `npm run pack:check` → `scripts/e2e-test.ps1` (22 PASS / 0 FAIL / 1 SKIP;
   needs system Edge, not run in CI) → final clean-tree check.

   Fast iterations: `-SkipBrowser` (skip the system-Edge pass) and
   `-SkipTarball` (skip tarball smoke + pack:check); a release candidate
   needs the full run. The manual steps below remain the fallback when one
   step must be run alone.

3. **Independent subagent E2E gate.** On the merged tree, spawn separate
   subagent lanes (not the feature author) for the browser matrix, the CLI E2E
   on sources and `dist`, the packed-tarball/clean-install flow, and a WSL
   Linux pass (typecheck + full package suite, so POSIX-only tests run). Each
   lane must report its command, count and PASS; one FAIL blocks publishing.
   The rehearsal above is the single-machine counterpart, not a replacement.
4. Push and confirm CI green on the ubuntu Node 22/24 matrix and the
   `windows-latest` Node 24 leg.
5. Only then follow the publishing checklist below (tag + workflow).

## One-time external setup (owner, ~5 minutes remaining)

1. **npm org and package existence are done.** `@two-brothers` exists and
   `@two-brothers/harness@0.0.0` is a live placeholder, so the package settings
   and Trusted Publisher UI are available. `npm whoami` is `nik1138`; local npm
   is **11.21.2**, which supports `npm trust`.
2. **Link the Trusted Publisher.** Open the package's
   **Settings → Trusted publishing** on npmjs.com (or
   <https://www.npmjs.com/package/@two-brothers/harness/access>) and add a
   GitHub Actions trusted publisher with:
   - Organization or user: `nik1138` (the GitHub owner, not the npm org)
   - Repository: `two-brothers-harness`
   - Workflow filename: `publish.yml` (filename only, case-sensitive)
   - Environment: *(leave blank — the workflow uses no GitHub environment;
     if you later add one to the workflow, enter its name in both places)*
   - Allowed actions: **npm publish** must be enabled. Configurations created
     after Sep 03 2026 default to stage-only (`npm stage publish`); this
     workflow runs direct `npm publish`, so stage-only is not enough.
     Optionally enable **npm dist-tag** if the workflow should promote tags.
     The package `repository.url` must match this GitHub repository exactly
     (it does in 0.0.1).

   CLI equivalent (needs account-level 2FA; npm prompts for an OTP or opens a
   browser authentication URL):

   ```powershell
   npm trust github @two-brothers/harness --file publish.yml --repo nik1138/two-brothers-harness --allow-publish
   npm trust list @two-brothers/harness   # verify; also needs the OTP
   ```

   Omitting `--environment` leaves it blank. A new trusted-publisher
   configuration must complete a successful publish within **2 days**, or it
   expires; do this immediately before running the workflow.

   **Private repository caveat:** npm does not generate provenance for
   packages built from private source repositories, even with trusted
   publishing. The workflow therefore does not pass `--provenance`; the
   package publishes without an attestation while the repo stays private.
   Make the repository public if you want the provenance badge.

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

### Source maps ship in the tarball

The package keeps its tsc source maps (`dist/*.js.map` and the declaration
maps): `sourceMap`/`declarationMap` are on in
`packages/harness/tsconfig.build.json`, and every `dist/*.js` already carries a
`sourceMappingURL`, so dropping the maps would leave dead links and a stack
trace that points into nowhere. Measured on the final package: **368 files,
1.28 MB packed / 5.17 MB unpacked**, of which **180 `.map` files are 1.60 MB
unpacked (30.9%)** — a small packed cost because maps compress well. That is
the deliberate trade: an npm-installed user, or a crash report from their
machine, gets a stack trace that resolves back to the TypeScript sources.

## After publishing 0.0.1 (docs, immediately)

The workflow publishes to **`next`**; the `0.0.0` placeholder still owns
`latest` until the promotion step below. Do not tell readers to install the
untagged package during that window.

1. Verify the registry:
   ```bash
   npm view @two-brothers/harness@next version
   npm view @two-brothers/harness dist-tags
   ```
2. Update the pre-release notes in the same docs commit:
   - root `README.md`: replace the "package is not on npm yet" paragraph and
     delete the `> **Pre-release:**` block in **Install**; use
     `npm install -g @two-brothers/harness@next` for now.
   - `packages/harness/README.md`: replace/remove the
     `> **Pre-release:**` block; use the same `@next` command.
   - `docs/quickstart.md`: change "once the package is published" to the
     actual `@next` install, or keep the source build as the first path and
     link the npm install as the packaged alternative.
   - `docs/release.md`: change **Status** from placeholder/ready to
     0.0.1 published on `next`.
3. Open the npm package page and confirm the README/license/repository and the
   `next` tag.

## Promote to `latest` and drop the `@next` suffix

When `@next` has soaked and you are ready to make it the default install:

```bash
npm dist-tag add @two-brothers/harness@0.0.1 latest
npm install -g @two-brothers/harness   # no tag = latest
```

Then switch the README/quickstart install commands from
`@two-brothers/harness@next` to the untagged package, and keep
`docs/release.md`'s **Status** line in sync. Do the README edits **after** the
tag is actually `latest`, so the docs never claim availability early.
