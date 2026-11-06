import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { apiUrlFor, fetchUsername, type ResolvedAccount } from '../core/forge'
import type { GitCredential } from '../core/git'
import type { ForgeAccount, ForgeKind } from '../shared/types'

interface StoredAccount extends ForgeAccount {
  /** Encrypted by the operating system's credential store. */
  token: string
}

export function normalizeHost(input: string): string {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new Error(`Некорректный адрес сервера: ${input}`)
  return host
}

/** Tokens stay in the main process, encrypted at rest. The interface sees only the public part. */
export class AccountStore {
  private accounts: StoredAccount[] = []

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.accounts = JSON.parse(await readFile(this.path, 'utf8')) as StoredAccount[]
    } catch {
      this.accounts = []
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.accounts, null, 2), { mode: 0o600 })
  }

  list(): ForgeAccount[] {
    return this.accounts.map(({ token: _token, ...account }) => account)
  }

  private decrypt(account: StoredAccount): string {
    return safeStorage.decryptString(Buffer.from(account.token, 'base64'))
  }

  find(host: string): ResolvedAccount | null {
    const stored = this.accounts.find((account) => account.host === host)
    if (!stored) return null
    try {
      const { token: _token, ...account } = stored
      return { account, token: this.decrypt(stored) }
    } catch {
      return null
    }
  }

  byId(id: string): ResolvedAccount | null {
    const stored = this.accounts.find((account) => account.id === id)
    return stored ? this.find(stored.host) : null
  }

  async add(kind: ForgeKind, hostInput: string, token: string): Promise<ForgeAccount> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Система не даёт зашифровать токен, поэтому он не сохранён')
    const host = normalizeHost(hostInput)
    const clean = token.trim()
    if (!clean) throw new Error('Пустой токен')
    const apiUrl = apiUrlFor(kind, host)
    const username = await fetchUsername({ kind, apiUrl }, clean)
    const account: StoredAccount = {
      id: randomUUID(), kind, host, apiUrl, username,
      token: safeStorage.encryptString(clean).toString('base64')
    }
    this.accounts = [...this.accounts.filter((item) => item.host !== host), account]
    await this.save()
    const { token: _token, ...publicAccount } = account
    return publicAccount
  }

  async remove(id: string): Promise<void> {
    this.accounts = this.accounts.filter((account) => account.id !== id)
    await this.save()
  }

  gitCredentials(): GitCredential[] {
    const credentials: GitCredential[] = []
    for (const account of this.accounts) {
      const resolved = this.find(account.host)
      if (resolved) {
        credentials.push({
          host: account.host,
          username: account.kind === 'github' ? 'x-access-token' : 'oauth2',
          token: resolved.token
        })
      }
    }
    return credentials
  }
}
