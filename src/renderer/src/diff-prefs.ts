import { useSyncExternalStore } from 'react'

export interface DiffPreferences {
  split: boolean
  ignoreWhitespace: boolean
}

const KEY = 'chronicle.diff'
const DEFAULTS: DiffPreferences = { split: false, ignoreWhitespace: false }
const listeners = new Set<() => void>()

function load(): DiffPreferences {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DiffPreferences> }
  } catch {
    return DEFAULTS
  }
}

let current = load()

export function setDiffPreferences(update: Partial<DiffPreferences>): void {
  current = { ...current, ...update }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Only a convenience: the choice still holds until the window closes.
  }
  for (const listener of listeners) listener()
}

/** How diffs are shown. The choice is shared by every diff in the window and remembered. */
export function useDiffPreferences(): DiffPreferences {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => current)
}
