import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { SecretStore } from '../core/prompt-broker'

/** Key passwords the person chose to keep, encrypted by the operating system's credential store. */
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
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  }

  get(key: string): string | null {
    const stored = this.entries[key]
    if (!stored) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return null
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.entries[key] = safeStorage.encryptString(value).toString('base64')
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
