# AGENTS.md — `packages/harness/scripts/`

Local map for package build/packaging helpers. Parent rules: `../AGENTS.md`;
root rules: `../../../AGENTS.md`.

## What lives here

- `sync-web.mjs` — copies the repo's built `web/dist` to `../web` so the npm
  tarball ships the UI (`web` is in `package.json` `files`). It builds nothing.

## Boundaries

- Keep this directory free of runtime code and dependencies; it runs under
  plain Node.
- Never edit the generated `../web/` copy by hand; change `web/src`, rebuild,
  then re-run the sync.
- `prepack` owns the release sequence: `clean` → `build` → `sync-web`. A lane
  that runs only `sync-web` must build `web/` first.

## Invariants and hazards

- `sync-web.mjs` fails fast when `../../web/dist/index.html` is missing; the
  fix is `cd web && npm run build` from the repo root, never checking in
  `web/dist`.
- The copy is a recursive overwrite of the whole target; do not add
  incremental-copy logic without tests.

## Commands

```powershell
# from the repo root
cd web
npm run build
cd ../packages/harness
npm run sync-web
npm run pack:check     # packed tarball shape (prepack runs the sequence)
```

Workflow: `../../../AGENTS.md` ("Subagent Lanes").
