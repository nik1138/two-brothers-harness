// E2E runner against the BUILT package (dist/) — the artifact npm ships.
// Requires `npm run build` first. Same suites and exit codes as run.ts;
// sets the env var the runner honors, then imports it.
process.env.TWO_BROTHERS_E2E_DIST = "1";
await import("./run.ts");
