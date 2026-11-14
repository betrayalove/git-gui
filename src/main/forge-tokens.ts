import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { whoAmI } from '../core/forge-api'
import type { ForgeAccount, ForgeKind } from '../shared/types'
import { t } from '../shared/i18n'
import { PassphraseStore } from './passphrases'

/**
 * Personal access tokens for GitHub and GitLab, one per server. The tokens are encrypted by the
 * system's credential store and never leave the main process; only the account names do.
 */
export class ForgeTokens {
  private accounts: ForgeAccount[] = []
  /** Decrypted once per session, so the credential store is not asked on every request. */
  private readonly cache = new Map<string, string>()
  private readonly secrets: PassphraseStore

  constructor(secretsPath: string, private readonly accountsPath: string) {
    this.secrets = new PassphraseStore(secretsPath)
  }

  async load(): Promise<void> {
    await this.secrets.load()
    try {
      this.accounts = JSON.parse(await readFile(this.accountsPath, 'utf8')) as ForgeAccount[]
    } catch {
      this.accounts = []
    }
  }

  private async saveAccounts(): Promise<void> {
    await mkdir(dirname(this.accountsPath), { recursive: true })
    // Tokens kept only for the session are not written down, so neither is their account.
    await writeFile(this.accountsPath, JSON.stringify(this.accounts.filter((account) => account.saved), null, 2))
  }

  list(): ForgeAccount[] {
    return this.accounts
  }

  /** What kind of server a host is, by the token saved for it; null when there is none. */
  kindFor(host: string): ForgeKind | null {
    return this.accounts.find((account) => account.host === host)?.kind ?? null
  }

  /** Checks the token with the server first, so a mistyped one is never kept. */
  async add(host: string, kind: ForgeKind, token: string): Promise<ForgeAccount> {
    const cleanHost = host.trim().toLowerCase()
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(cleanHost)) throw new Error(t('Недопустимое имя сервера: {host}', { host }))
    if (kind !== 'github' && kind !== 'gitlab') throw new Error(t('Неизвестный тип сервера'))
    const cleanToken = token.trim()
    if (!cleanToken || /\s/.test(cleanToken)) throw new Error(t('Токен пустой или содержит пробелы'))
    const name = await whoAmI(kind, `https://${cleanHost}`, cleanToken)
    const saved = this.secrets.available()
    if (saved) await this.secrets.set(cleanHost, cleanToken)
    this.cache.set(cleanHost, cleanToken)
    const account: ForgeAccount = { host: cleanHost, kind, account: name, saved }
    this.accounts = [...this.accounts.filter((item) => item.host !== cleanHost), account]
    await this.saveAccounts()
    return account
  }

  async remove(host: string): Promise<void> {
    this.cache.delete(host)
    await this.secrets.delete(host)
    this.accounts = this.accounts.filter((account) => account.host !== host)
    await this.saveAccounts()
  }

  async token(host: string): Promise<string | null> {
    if (!this.accounts.some((account) => account.host === host)) return null
    const cached = this.cache.get(host)
    if (cached) return cached
    const token = await this.secrets.get(host)
    if (token) this.cache.set(host, token)
    return token
  }
}

let shared: ForgeTokens | null = null

/** The store is made once the app knows its data folder, which can change for the portable build. */
export function setForgeTokens(store: ForgeTokens): void {
  shared = store
}

export function forgeTokens(): ForgeTokens {
  if (!shared) throw new Error('Forge tokens used before the app started')
  return shared
}
