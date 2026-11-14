import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { SecretStore } from '../core/prompt-broker'

const KEYCHAIN_WAIT_MS = 2 * 60_000

/**
 * Secrets the person chose to keep, such as key passwords and server tokens, encrypted by the
 * operating system's credential store.
 *
 * On macOS any use of the store may show a system dialog, which an unsigned build gets after every
 * update, and the synchronous calls would freeze the whole app until it is answered. So only the
 * asynchronous calls are used, and only when a password is really being saved or read.
 */
export class PassphraseStore implements SecretStore {
  private entries: Record<string, string> = {}

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.entries = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>
    } catch {
      this.entries = {}
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
  }

  /** On Linux without a keyring Electron falls back to a fixed key, which protects nothing. */
  available(): boolean {
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  async get(key: string): Promise<string | null> {
    const stored = this.entries[key]
    if (!stored) return null
    let timer: NodeJS.Timeout | undefined
    try {
      // A dialog nobody answers must not hold up a timed publish for good.
      const unanswered = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), KEYCHAIN_WAIT_MS) })
      const decrypted = await Promise.race([safeStorage.decryptStringAsync(Buffer.from(stored, 'base64')), unanswered])
      if (!decrypted) return null
      if (decrypted.shouldReEncrypt) await this.set(key, decrypted.result)
      return decrypted.result
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.entries[key] = (await safeStorage.encryptStringAsync(value)).toString('base64')
    await this.save()
  }

  async delete(key: string): Promise<void> {
    if (!(key in this.entries)) return
    delete this.entries[key]
    await this.save()
  }

  count(): number {
    return Object.keys(this.entries).length
  }

  async clear(): Promise<void> {
    this.entries = {}
    await this.save()
  }
}
