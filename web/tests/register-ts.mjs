// Test bootstrap: register the TypeScript resolve hook so plain-node
// `node --test` can run the projection modules (runtime.ts value-imports
// './chat' without an extension; see ts-resolve-hook.mjs).
// Usage (from web/):
//   node --import ./tests/register-ts.mjs --test tests/chat.test.ts tests/timeline.test.ts
import { register } from 'node:module'

register('./ts-resolve-hook.mjs', import.meta.url)
