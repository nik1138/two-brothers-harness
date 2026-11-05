/**
 * UI density preference (P1): Comfortable (default) or Compact.
 *
 * The preference is visual only — `data-density` on <html> scales row heights
 * and vertical padding in style.css; no layout or behaviour changes. Like the
 * draft store, this module has no DOM or Vue dependency: the storage backend
 * is injected (`StorageLike` from drafts.ts), every operation is fail-soft,
 * and the value lives under a single versioned localStorage key. An unknown,
 * missing or unreadable value resolves to Comfortable, so a corrupted blob can
 * never leave the app without a spacing mode.
 */

import type { StorageLike } from './drafts'

/** The two supported spacing modes. */
export type Density = 'comfortable' | 'compact'

/** Versioned key: bump the suffix when the stored shape changes incompatibly. */
export const DENSITY_STORAGE_KEY = 'two-brothers.density.v1'

/** Attribute written on <html>; style.css keys every density rule off it. */
export const DENSITY_ATTRIBUTE = 'data-density'

/** Used whenever nothing usable is stored. */
export const DEFAULT_DENSITY: Density = 'comfortable'

/** The minimal Storage surface this module needs (a `Storage` satisfies it). */
export interface DensityStoreOptions {
  /**
   * Storage backend. Omitted = `window.localStorage` when it is reachable;
   * explicit `null` disables persistence (tests and non-DOM callers).
   */
  storage?: StorageLike | null
}

/** Anything that can carry the attribute — an Element satisfies it. */
export interface DensityAttributeHost {
  setAttribute(name: string, value: string): void
}

const DENSITIES: readonly Density[] = ['comfortable', 'compact']

/** Runtime guard for values that crossed a storage or type boundary. */
export function isDensity(value: unknown): value is Density {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value)
}

/** A browser `localStorage` if it exists and reading it does not throw. */
export function defaultDensityStorage(): StorageLike | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage ?? null
  } catch {
    // even accessing the property can throw when storage is blocked
    return null
  }
}

function resolveStorage(options: DensityStoreOptions): StorageLike | null {
  return options.storage === undefined ? defaultDensityStorage() : options.storage
}

/** Stored preference, or Comfortable when nothing usable is stored. */
export function readDensity(options: DensityStoreOptions = {}): Density {
  const storage = resolveStorage(options)
  if (!storage) return DEFAULT_DENSITY
  try {
    const saved = storage.getItem(DENSITY_STORAGE_KEY)
    return isDensity(saved) ? saved : DEFAULT_DENSITY
  } catch {
    return DEFAULT_DENSITY
  }
}

/**
 * Persist one preference. Blocked storage and quota errors are swallowed: the
 * choice still applies for this page view, only the next visit forgets it.
 */
export function saveDensity(density: Density, options: DensityStoreOptions = {}): void {
  if (!isDensity(density)) return
  const storage = resolveStorage(options)
  if (!storage) return
  try {
    storage.setItem(DENSITY_STORAGE_KEY, density)
  } catch {
    // storage blocked / quota exceeded: the in-memory preference survives
  }
}

/** Write (or, with an explicit host, target) the attribute style.css reads. */
export function applyDensityAttribute(
  density: Density,
  host?: DensityAttributeHost | null,
): void {
  const target =
    host === undefined
      ? typeof document === 'undefined'
        ? null
        : document.documentElement
      : host
  if (!target) return
  target.setAttribute(DENSITY_ATTRIBUTE, isDensity(density) ? density : DEFAULT_DENSITY)
}

/** The other mode — one keyboard/palette action can flip the setting. */
export function otherDensity(density: Density): Density {
  return density === 'compact' ? 'comfortable' : 'compact'
}
