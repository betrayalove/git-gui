import { randomUUID } from 'node:crypto'
import { parsePrompt, type AccessPrompt, type ParsedPrompt, type PromptReply } from '../shared/access'
import type { AskpassRequest } from './askpass'

/** Encrypted storage for key passwords. Absent when the system offers no safe place. */
export interface SecretStore {
  available(): boolean
  get(key: string): string | null
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

const SESSION_MS = 15 * 60_000
const ATTEMPTS = 3

/** One push checks the server several times, and each check would otherwise ask again. */
export function normalizeKeyPath(path: string): string {
  const slashes = path.replaceAll('\\', '/')
  const msys = /^\/([a-zA-Z])\//.exec(slashes)
  const full = msys ? `${msys[1]}:/${slashes.slice(3)}` : slashes
  return /^[a-zA-Z]:\//.test(full) ? full.toLowerCase() : full
}

/** Decides what to answer: a known key password if there is one, otherwise the person. */
export class PromptBroker {
  private readonly session = new Map<string, { value: string; at: number }>()

  constructor(
    private readonly ask: (prompt: AccessPrompt) => Promise<PromptReply | null>,
    private readonly saved: SecretStore,
    /** Tells a wrong password early. ssh often gives up after one wrong answer instead of asking again. */
    private readonly verify: (keyPath: string, value: string) => Promise<boolean> = async () => true,
    private readonly now: () => number = Date.now
  ) {}

  private known(key: string): string | null {
    const entry = this.session.get(key)
    if (entry && this.now() - entry.at < SESSION_MS) return entry.value
    this.session.delete(key)
    return this.saved.get(key)
  }

  async remember(keyPath: string, value: string, persist: boolean): Promise<void> {
    const key = normalizeKeyPath(keyPath)
    this.session.set(key, { value, at: this.now() })
    if (persist && this.saved.available()) await this.saved.set(key, value)
  }

  private async forget(key: string): Promise<void> {
    this.session.delete(key)
    await this.saved.delete(key)
  }

  private toPrompt(parsed: ParsedPrompt, isKey: boolean): AccessPrompt {
    return { ...parsed, id: randomUUID(), canRemember: isKey && this.saved.available() }
  }

  clearSession(): void {
    this.session.clear()
  }

  async handle(request: AskpassRequest): Promise<string | null> {
    const parsed = parsePrompt(request.prompt)
    const key = parsed.keyPath ? normalizeKeyPath(parsed.keyPath) : null
    if (!key) return request.background ? null : (await this.ask(this.toPrompt(parsed, false)))?.answer ?? null
    if (parsed.retry) await this.forget(key)
    else {
      const known = this.known(key)
      if (known !== null) {
        if (await this.verify(parsed.keyPath!, known)) return known
        await this.forget(key)
      }
    }
    if (request.background) return null
    let retry = Boolean(parsed.retry)
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const reply = await this.ask(this.toPrompt({ ...parsed, retry }, true))
      if (!reply) return null
      if (await this.verify(parsed.keyPath!, reply.answer)) {
        await this.remember(key, reply.answer, Boolean(reply.remember))
        return reply.answer
      }
      retry = true
    }
    return null
  }
}
