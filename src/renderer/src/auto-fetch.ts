import { useSyncExternalStore } from 'react'
import type { AutoFetchMinutes } from '../../shared/types'
import { appApi } from './api'

const listeners = new Set<() => void>()
/** Null until the saved choice arrives, so nothing fetches against the person's wish in the meantime. */
let current: AutoFetchMinutes | null = null

function publish(minutes: AutoFetchMinutes): void {
  current = minutes
  for (const listener of listeners) listener()
}

void appApi.autoFetchMinutes().then(publish).catch(() => {})

export async function setAutoFetchMinutes(minutes: AutoFetchMinutes): Promise<void> {
  await appApi.setAutoFetchMinutes(minutes)
  publish(minutes)
}

/** How often every open repository fetches by itself; 0 when that is off. Shared by all tabs. */
export function useAutoFetchMinutes(): AutoFetchMinutes | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => current)
}
