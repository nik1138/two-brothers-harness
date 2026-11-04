# Two Brothers — Web Workspace

Vue 3 + TypeScript workspace for Operator/Senior/Junior cooperation sessions.

## Develop

```bash
npm install
npm run dev
```

Vite serves the app (default http://localhost:5173) and proxies `/api` to the
backend at `http://127.0.0.1:8600` (see `vite.config.ts`).

## Build

```bash
npm run build
```

Output goes to `web/dist`. In a repo checkout the TypeScript server
(`node dist/cli.js serve` from `packages/harness/`) serves that build at `/`;
the npm tarball ships a copy under the package's `web/` directory and serves
it the same way.
