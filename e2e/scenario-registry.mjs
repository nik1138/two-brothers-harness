// Single source of truth for the browser-E2E scenario registry (e2e/run.mjs).
//
// e2e/run.mjs builds its hermetic scenario blocks from HERMETIC_LABELS, in
// this order, and derives the missing-backend SKIP report (emitted when
// packages/harness/dist is not built) from the same list — so a scenario
// added here can never be silently omitted from that report. The previous
// hand-maintained fallback list drifted and dropped model-switch plus the
// four subagent scenarios; e2e/skip-registry.test.mjs guards the parity.
//
// A label is the block name matched by TWO_BROTHERS_E2E_ONLY. Almost every
// block reports exactly one result with the same name; a '/'-joined label
// (currently only 'chat/resume') is one block that passes several results.

export const HERMETIC_LABELS = Object.freeze([
  'chat/resume',
  'approval-allow',
  'approval-deny',
  'approval-reduced-motion',
  'stop',
  'mobile',
  'appearance-density',
  'appearance-accent',
  'appearance-roles',
  'keybindings',
  'provider-reset',
  'folding',
  'plan-dock',
  'subagents',
  'subagent-mutation',
  'subagent-controls',
  'subagent-followups',
  'composer-seats',
  'model-switch',
  'hero-starters',
  'composer-recall',
  'approval-reason',
  'tool-preview',
  'workspace-drag',
  'reasoning-replay',
  'cooperation-surfaces',
  'auto-solo',
  'tab-title',
  'settings-advanced',
  'settings-subagent',
  'settings-preset-sync',
  'settings-quality',
  'session-switch-race',
  'subagent-switch-race',
  'reconnect-exhaustion',
  'stop-switch-leak',
  'history-nav',
  'transcript-stability',
  'stream-follow',
  'stream-follow-touch',
])

/** Result names a label contributes to the missing-backend SKIP report. */
export function labelResultNames(label) {
  return label.split('/')
}

/**
 * Every hermetic result name in registry order (one more than
 * HERMETIC_LABELS.length: 'chat/resume' contributes two results, chat and
 * resume). The opt-in 'real' scenario is not hermetic and is never here.
 */
export function hermeticResultNames() {
  return HERMETIC_LABELS.flatMap(labelResultNames)
}
