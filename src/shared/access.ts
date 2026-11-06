import { parseRemoteUrl, type ParsedRemote } from './remote-url'

export type AccessIssue =
  | 'no-key'
  | 'passphrase'
  | 'host-unknown'
  | 'host-changed'
  | 'https-auth'
  | 'no-access'
  | 'offline'
  | 'protected'
  | 'ssh-missing'

const RULES: [AccessIssue, RegExp][] = [
  ['passphrase', /incorrect passphrase|bad passphrase/i],
  ['host-changed', /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i],
  ['host-unknown', /Host key verification failed/i],
  ['no-key', /Permission denied \([^)]*publickey[^)]*\)|Too many authentication failures|no mutual signature/i],
  ['ssh-missing', /cannot run ssh|ssh: (command )?not found/i],
  ['protected', /GH006|GH013|protected branch|not allowed to force push|deny updating a hidden ref/i],
  ['no-access', /Repository not found|does not appear to be a git repository|project you were looking for could not be found|Permission to \S+ denied|you are not allowed to|access denied or repository not exported/i],
  ['https-auth', /could not read (Username|Password)|Authentication failed for|Invalid username or (password|token)|HTTP Basic: Access denied|terminal prompts disabled|The requested URL returned error: 40[13]|password authentication was removed/i],
  ['offline', /Could not resolve (hostname|host)|Connection timed out|Operation timed out|Connection refused|Network is unreachable|No route to host|Failed to connect to|kex_exchange_identification|Connection closed by|Couldn't connect to server/i],
  ['no-access', /Could not read from remote repository/i]
]

/** Recognizes a refused connection in git's or ssh's output. Null means some other problem. */
export function classifyAccessError(message: string): AccessIssue | null {
  return RULES.find(([, pattern]) => pattern.test(message))?.[0] ?? null
}

export function issueSummary(issue: AccessIssue, host?: string): string {
  const server = host ?? 'сервер'
  switch (issue) {
    case 'no-key': return `Этот компьютер ещё не подключён к ${server}: сервер не принял ни один SSH-ключ.`
    case 'passphrase': return 'Пароль SSH-ключа не подошёл.'
    case 'host-unknown': return `Это первое подключение к ${server}, и его нужно подтвердить.`
    case 'host-changed': return `Ключ сервера ${server} изменился. Это может быть смена оборудования, а может быть подмена.`
    case 'https-auth': return `Для адреса на ${server} нет сохранённого входа.`
    case 'no-access': return `У подключённого аккаунта нет доступа к этому репозитории на ${server}, или адрес неверный.`
    case 'offline': return `Сервер ${server} недоступен. Проверь интернет: ключи здесь ни при чём.`
    case 'protected': return 'Сервер отклонил отправку: ветка защищена.'
    case 'ssh-missing': return 'На компьютере не найден ssh. Установи Git или OpenSSH и повтори.'
  }
}

/** Where a connection can be tested. Null when the address is not on a server. */
export interface SshTarget {
  host: string
  user: string
  port?: number
}

export function targetFromRemote(parsed: ParsedRemote): SshTarget | null {
  if (parsed.protocol === 'ssh') return { host: parsed.host, user: parsed.user ?? 'git', ...(parsed.port ? { port: parsed.port } : {}) }
  return parsed.host.includes(':') ? null : { host: parsed.host, user: 'git' }
}

export function targetFromUrl(url: string): SshTarget | null {
  const parsed = parseRemoteUrl(url)
  return parsed ? targetFromRemote(parsed) : null
}

/** The SSH address of an HTTPS remote. Null when one cannot be guessed. */
export function toSshUrl(url: string): string | null {
  const parsed = parseRemoteUrl(url)
  if (!parsed || parsed.protocol === 'ssh' || parsed.host.includes(':')) return null
  return `git@${parsed.host}:${parsed.path}.git`
}

export function sshKeysPage(kind: 'github' | 'gitlab', host: string): string {
  return kind === 'github' ? `https://${host}/settings/ssh/new` : `https://${host}/-/user_settings/ssh_keys`
}

export type PromptKind = 'passphrase' | 'password' | 'username' | 'host-key' | 'confirm' | 'text'

export interface ParsedPrompt {
  kind: PromptKind
  text: string
  /** The answer should not show on screen. */
  hidden: boolean
  keyPath?: string
  /** A previous answer was wrong. */
  retry?: boolean
  host?: string
  fingerprint?: string
}

/** Reads what ssh or git is asking. Their wording is stable because they run with LC_ALL=C. */
export function parsePrompt(text: string): ParsedPrompt {
  const clean = text.trim()
  const bad = /^Bad passphrase, try again for (.+?):?$/i.exec(clean)
  if (bad) return { kind: 'passphrase', text: clean, hidden: true, keyPath: bad[1], retry: true }
  const passphrase = /passphrase(?: for)?(?: key)?\s*['"]?([^'"]*?)['"]?\s*:?$/i.exec(clean)
  if (/passphrase/i.test(clean) && passphrase) {
    return { kind: 'passphrase', text: clean, hidden: true, ...(passphrase[1] ? { keyPath: passphrase[1] } : {}) }
  }
  if (/authenticity of host/i.test(clean)) {
    return {
      kind: 'host-key', text: clean, hidden: false,
      host: /authenticity of host '([^' ]+)/i.exec(clean)?.[1],
      fingerprint: /(SHA256:[A-Za-z0-9+/=]+)/.exec(clean)?.[1]
    }
  }
  if (/\(yes\/no/i.test(clean)) return { kind: 'confirm', text: clean, hidden: false }
  if (/^Username for /i.test(clean)) return { kind: 'username', text: clean, hidden: false, host: /'([^']+)'/.exec(clean)?.[1] }
  if (/password/i.test(clean)) return { kind: 'password', text: clean, hidden: true }
  return { kind: 'text', text: clean, hidden: /pin|code|token|secret/i.test(clean) }
}

export interface AccessPrompt extends ParsedPrompt {
  id: string
  canRemember: boolean
}

export interface PromptReply {
  answer: string
  remember?: boolean
}
