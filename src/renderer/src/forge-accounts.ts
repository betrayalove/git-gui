import { useSyncExternalStore } from 'react'
import type { ForgeAccount, ForgeKind } from '../../shared/types'
import { appApi } from './api'

const listeners = new Set<() => void>()
/** Null until the list arrives from the main process. */
let current: ForgeAccount[] | null = null

function publish(accounts: ForgeAccount[]): void {
  current = accounts
  for (const listener of listeners) listener()
}

void appApi.forgeAccounts().then(publish).catch(() => publish([]))

export async function addForgeToken(host: string, kind: ForgeKind, token: string): Promise<ForgeAccount> {
  const account = await appApi.addForgeToken(host, kind, token)
  publish(await appApi.forgeAccounts())
  return account
}

export async function removeForgeToken(host: string): Promise<void> {
  await appApi.removeForgeToken(host)
  publish(await appApi.forgeAccounts())
}

/** Servers with a saved token, shared by every tab and the settings. */
export function useForgeAccounts(): ForgeAccount[] | null {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => current)
}
