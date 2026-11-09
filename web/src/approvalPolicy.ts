// Pure model for Settings → Permissions: the named permission presets, the
// operator approval modes they apply, their honest copy, fail-closed
// normalization of the backend payload, and the save helper. No DOM and no Vue
// imports, so `tests/approvalPolicy.test.ts` covers it directly:
//   node --import ./tests/register-ts.mjs --test tests/approvalPolicy.test.ts
//
// The preset/mode vocabulary mirrors `packages/harness/src/permissions.ts`
// (`PermissionPreset` / `PERMISSION_PRESET_INFO` / `ApprovalMode`). It is
// duplicated here because the web workspace is a separate Vite app that never
// imports backend sources; keep the names and the truthful copy in sync when
// the server enum changes.

import type { ApprovalMode, ApprovalPolicyView } from './types'

/** Every operator approval mode, in display order (default first). */
export const APPROVAL_MODES: readonly ApprovalMode[] = [
  'ask',
  'readonly',
  'edits',
  'allow-all',
]

/** Fail-closed default: an absent/unknown policy means `ask`. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = 'ask'

/** Operator-facing copy for one mode. */
export interface ApprovalModeCopy {
  mode: ApprovalMode
  label: string
  /** One truthful sentence about what the mode allows without asking. */
  description: string
  /** Destructive warning, present only for a mode that weakens a guardrail. */
  danger?: string
}

const MODE_COPY: Readonly<Record<ApprovalMode, ApprovalModeCopy>> = {
  ask: {
    mode: 'ask',
    label: 'Ask',
    description:
      'Reads run freely. Writes, edits, deletes and shell commands wait for your approval.',
  },
  readonly: {
    mode: 'readonly',
    label: 'Read only',
    description:
      'Only reads run. Every write, edit, delete and shell command is denied without asking.',
  },
  edits: {
    mode: 'edits',
    label: 'Edits',
    description:
      'Reads, writes and edits run freely. Deletes and shell commands wait for your approval.',
  },
  'allow-all': {
    mode: 'allow-all',
    label: 'Allow all',
    description: 'Everything runs without asking, including deletes and shell commands.',
    danger:
      'Use only in a workspace you trust: a mistaken model step becomes an irreversible change.',
  },
}

/** Strict enum guard: only the four exact mode names are accepted. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === 'string' && (APPROVAL_MODES as readonly string[]).includes(value)
}

/** Never returns a more permissive mode than the input proved. */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return isApprovalMode(value) ? value : DEFAULT_APPROVAL_MODE
}

export function approvalModeCopy(mode: ApprovalMode): ApprovalModeCopy {
  return MODE_COPY[normalizeApprovalMode(mode)]
}

/** The visible destructive warning for a mode, or null when it keeps asking. */
export function approvalModeDanger(mode: ApprovalMode): string | null {
  return approvalModeCopy(mode).danger ?? null
}

// ---------------------------------------------------------------------------
// Named permission presets (deepseek-harness style)
// ---------------------------------------------------------------------------

/** Every selectable preset, most restrictive first. */
export const PERMISSION_PRESETS = [
  'read-only',
  'ask',
  'workspace-write',
  'danger-full-access',
] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

/** Reserved presentation value for a stored mode that matches no preset. */
export const CUSTOM_PERMISSION_PRESET = 'custom'

/** One preset's truthful presentation and the mode it selects. */
export interface PermissionPresetCopy {
  preset: PermissionPreset
  /** The persisted `approval_policy.mode` this preset applies. */
  mode: ApprovalMode
  label: string
  /** One truthful sentence about what runs without asking. */
  description: string
  /** Destructive warning; present only for the fully permissive preset. */
  danger?: string
}

export const PERMISSION_PRESET_COPY: Readonly<Record<PermissionPreset, PermissionPresetCopy>> = {
  'read-only': {
    preset: 'read-only',
    mode: 'readonly',
    label: 'Read only',
    description:
      'Reads run freely. Writes, edits, deletes and shell commands are denied without asking.',
  },
  ask: {
    preset: 'ask',
    mode: 'ask',
    label: 'Always ask',
    description:
      'Reads run freely. Writes, edits, deletes and shell commands ask before they run.',
  },
  'workspace-write': {
    preset: 'workspace-write',
    mode: 'edits',
    label: 'Workspace write',
    description:
      'Reads, writes and edits run freely inside the workspace. Deletes and shell commands ask before they run.',
  },
  'danger-full-access': {
    preset: 'danger-full-access',
    mode: 'allow-all',
    label: 'Full access',
    description: 'Everything runs without asking, including deletes and shell commands.',
    danger:
      'Use only in a workspace you trust: a mistaken model step becomes an irreversible change.',
  },
}

/** Canonical comparison key for a preset/mode spelling. */
function presetKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const PRESET_ALIASES: Readonly<Record<string, PermissionPreset>> = {
  'read-only': 'read-only',
  readonly: 'read-only',
  'readonly-mode': 'read-only',
  ask: 'ask',
  'workspace-write': 'workspace-write',
  workspacewrite: 'workspace-write',
  edits: 'workspace-write',
  edit: 'workspace-write',
  'workspace-edits': 'workspace-write',
  'danger-full-access': 'danger-full-access',
  'full-access': 'danger-full-access',
  fullaccess: 'danger-full-access',
  'allow-all': 'danger-full-access',
  allowall: 'danger-full-access',
}

/** Strict preset lookup for command input; `null` for anything else. */
export function normalizePermissionPreset(value: unknown): PermissionPreset | null {
  if (typeof value !== 'string') return null
  const key = presetKey(value)
  // Guard inherited keys ("constructor", "__proto__", …): a bare lookup would
  // return a function and violate the PermissionPreset | null contract.
  return Object.prototype.hasOwnProperty.call(PRESET_ALIASES, key) ? PRESET_ALIASES[key]! : null
}

/** The preset copy that presents one stored mode (every current mode maps). */
export function permissionPresetOf(mode: ApprovalMode): PermissionPresetCopy {
  const id = permissionPresetId(mode)
  // Fail closed to the asking preset for a future/unknown mode rather than
  // inventing a permissive label.
  return id === CUSTOM_PERMISSION_PRESET ? PERMISSION_PRESET_COPY.ask : PERMISSION_PRESET_COPY[id]
}

/** The preset id that presents one stored mode, or `custom` if none matches. */
export function permissionPresetId(mode: unknown): PermissionPreset | typeof CUSTOM_PERMISSION_PRESET {
  if (!isApprovalMode(mode)) return CUSTOM_PERMISSION_PRESET
  for (const preset of PERMISSION_PRESETS) {
    if (PERMISSION_PRESET_COPY[preset].mode === mode) return preset
  }
  return CUSTOM_PERMISSION_PRESET
}

/** The visible destructive warning for a preset, or null when it keeps asking. */
export function permissionPresetDanger(preset: PermissionPreset): string | null {
  return PERMISSION_PRESET_COPY[preset].danger ?? null
}

/** What the settings dialog knows about the server's approval policy. */
export interface ApprovalPolicyState {
  /** Selected/effective mode; fail-closed `ask` for any unknown payload. */
  mode: ApprovalMode
  /**
   * True when the backend returned an `approval_policy` section, i.e. it
   * understands and persists modes. An older backend omits the field; the
   * dialog must then show `ask` and must not send an approval patch.
   */
  supported: boolean
  /**
   * True when a serve flag/env pin overrides the persisted mode. The pin
   * cannot be changed from this app; saving a mode is still safe (it is the
   * persisted default once the pin is removed) but the UI must say so.
   */
  pinned: boolean
}

/**
 * Read `GET /api/settings`' additive `approval_policy` section fail-soft: a
 * missing field (old backend) means unsupported + `ask`; a present but
 * malformed mode still proves support and reads as `ask` (never a more
 * permissive mode).
 */
export function approvalPolicyOf(settings: unknown): ApprovalPolicyState {
  if (settings === null || typeof settings !== 'object') {
    return { mode: DEFAULT_APPROVAL_MODE, supported: false, pinned: false }
  }
  const section = (settings as { approval_policy?: unknown }).approval_policy
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    return { mode: DEFAULT_APPROVAL_MODE, supported: false, pinned: false }
  }
  const view = section as ApprovalPolicyView & { mode?: unknown }
  return {
    mode: normalizeApprovalMode(view.mode),
    supported: true,
    pinned: view.pinned === true,
  }
}

/**
 * The settings save payload for the policy, or `{}` when the app must not send
 * the section: an older backend never reported it (sending an unknown key would
 * be dropped at best, and not sending keeps old settings documents untouched),
 * or a server-process pin currently owns the mode (`serve --approval-mode` /
 * `TWO_BROTHERS_APPROVAL_MODE`). A pin is deliberately never persisted, so a
 * Save while pinned must not turn it into the durable default.
 */
export function approvalPolicyPatch(
  state: Pick<ApprovalPolicyState, 'mode' | 'supported' | 'pinned'>,
): { approval_policy?: { mode: ApprovalMode } } {
  return state.supported && !state.pinned
    ? { approval_policy: { mode: normalizeApprovalMode(state.mode) } }
    : {}
}

/**
 * Why the selector is read-only, or null when the operator may change it.
 * A pinned mode is applied by the server process; an old backend cannot
 * persist a change at all.
 */
export function approvalPolicyDisabledReason(
  state: Pick<ApprovalPolicyState, 'supported' | 'pinned'>,
): string | null {
  if (state.pinned) {
    return (
      'Pinned by the server startup flag or TWO_BROTHERS_APPROVAL_MODE. ' +
      'Restart the server without the pin to choose a mode here.'
    )
  }
  if (!state.supported) {
    return (
      'This backend does not support approval modes yet; it applies Ask. ' +
      'Restart it from a current @two-brothers/harness build to choose a mode.'
    )
  }
  return null
}
