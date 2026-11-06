import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, hostname, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { classifyAccessError, type AccessIssue, type SshTarget } from '../shared/access'
import type { AskpassServer } from './askpass'
import { childEnv, gitLine, GitError, runGit } from './git'

export interface SshKey {
  /** The fingerprint, or the path while the public part is unknown. */
  id: string
  name: string
  /** The private key file. Null for a key that lives only in the agent, such as a hardware token. */
  path: string | null
  /** The whole line to paste on a site. Null when it has to be derived with the key's password first. */
  publicKey: string | null
  type: string
  comment: string
  fingerprint: string | null
  inAgent: boolean
}

export type KeyStatus =
  | { state: 'connected'; account: string | null }
  /** The server knows this key, but its password has not been entered. */
  | { state: 'locked' }
  | { state: 'rejected' }
  | { state: 'unknown' }
  | { state: 'failed'; issue: AccessIssue | null; message: string }

export type HostProbe = 'reachable' | 'rejected' | 'changed' | 'offline' | 'no-ssh'

interface ToolResult {
  code: number
  stdout: string
  stderr: string
  missing: boolean
}

const CHECK_TIMEOUT_MS = 20_000

function sshHome(): string {
  if (process.env.CHRONICLE_SSH_HOME) return process.env.CHRONICLE_SSH_HOME
  // On Windows, Git's ssh follows HOME where one is set.
  return (process.platform === 'win32' && process.env.HOME) || homedir()
}

export function sshDir(): string {
  return join(sshHome(), '.ssh')
}

function configArgs(): string[] {
  return process.env.CHRONICLE_SSH_CONFIG ? ['-F', process.env.CHRONICLE_SSH_CONFIG] : []
}

/** Finds Git's own tools by walking up from its exec path. The folder between them varies by Git version. */
export function gitUsrBin(execPath: string): string | null {
  for (let dir = execPath, depth = 0; depth < 6; dir = dirname(dir), depth++) {
    const bin = join(dir, 'usr', 'bin')
    if (existsSync(join(bin, 'ssh.exe'))) return bin
    if (dirname(dir) === dir) break
  }
  return null
}

let tools: Promise<{ ssh: string; keygen: string; add: string }> | null = null

/**
 * Windows has two unrelated copies of ssh with separate agents. Git uses its own, so checks must
 * use that one too, or they would report something else than what a push will do.
 */
function findTools(): Promise<{ ssh: string; keygen: string; add: string }> {
  tools ??= (async () => {
    const bare = { ssh: 'ssh', keygen: 'ssh-keygen', add: 'ssh-add' }
    if (process.platform !== 'win32') return bare
    try {
      const bin = gitUsrBin(await gitLine(process.cwd(), ['--exec-path']))
      if (bin) return { ssh: join(bin, 'ssh.exe'), keygen: join(bin, 'ssh-keygen.exe'), add: join(bin, 'ssh-add.exe') }
    } catch {
      // Falls back to whatever is on PATH.
    }
    return bare
  })()
  return tools
}

function runTool(binary: string, args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { windowsHide: true, env: childEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: error.message, missing: (error as NodeJS.ErrnoException).code === 'ENOENT' })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), missing: false })
    })
  })
}

function fingerprintOf(blob: string): string {
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

interface PublicLine {
  type: string
  blob: string
  comment: string
}

function parsePublicLine(line: string): PublicLine | null {
  const match = /^((?:ssh|ecdsa|sk)-[\w@.-]+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?$/.exec(line.trim())
  return match ? { type: match[1], blob: match[2], comment: match[3]?.trim() ?? '' } : null
}

function shortType(type: string): string {
  return type.replace(/^ssh-/, '').replace(/^ecdsa-sha2-nistp\d+$/, 'ecdsa').replace(/@openssh\.com$/, '')
}

async function identityFiles(host: string): Promise<string[]> {
  const { ssh } = await findTools()
  const { stdout } = await runTool(ssh, [...configArgs(), '-G', '--', host], { timeoutMs: CHECK_TIMEOUT_MS })
  return stdout.split('\n')
    .map((line) => /^identityfile\s+(.+)$/i.exec(line.trim())?.[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => (path.startsWith('~/') ? join(sshHome(), path.slice(2)) : path))
}

async function agentKeys(): Promise<PublicLine[]> {
  const { add } = await findTools()
  const { code, stdout } = await runTool(add, ['-L'], { timeoutMs: CHECK_TIMEOUT_MS })
  if (code !== 0) return []
  return stdout.split('\n').map(parsePublicLine).filter((line): line is PublicLine => Boolean(line))
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll('\\', '/') === b.replaceAll('\\', '/')
}

/** Finds the keys on this computer, in the order ssh itself would try them. Private files are not read. */
export async function listKeys(host = 'github.com'): Promise<SshKey[]> {
  const dir = sshDir()
  const [names, agent, preferred] = await Promise.all([
    readdir(dir).catch(() => [] as string[]),
    agentKeys(),
    identityFiles(host)
  ])
  const agentBlobs = new Set(agent.map((line) => line.blob))
  const keys: SshKey[] = []
  const seen = new Set<string>()
  for (const name of names.filter((item) => item.endsWith('.pub'))) {
    const parsed = parsePublicLine(await readFile(join(dir, name), 'utf8').catch(() => ''))
    if (!parsed) continue
    const path = join(dir, name.slice(0, -'.pub'.length))
    const hasPrivate = existsSync(path)
    const inAgent = agentBlobs.has(parsed.blob)
    if (!hasPrivate && !inAgent) continue
    seen.add(parsed.blob)
    const fingerprint = fingerprintOf(parsed.blob)
    keys.push({
      id: fingerprint,
      name: name.slice(0, -'.pub'.length),
      path: hasPrivate ? path : null,
      publicKey: `${parsed.type} ${parsed.blob}${parsed.comment ? ` ${parsed.comment}` : ''}`,
      type: shortType(parsed.type),
      comment: parsed.comment,
      fingerprint,
      inAgent
    })
  }
  for (const line of agent) {
    if (seen.has(line.blob)) continue
    seen.add(line.blob)
    const fingerprint = fingerprintOf(line.blob)
    keys.push({
      id: fingerprint,
      name: line.comment || 'Ключ из SSH-агента',
      path: null,
      publicKey: `${line.type} ${line.blob}${line.comment ? ` ${line.comment}` : ''}`,
      type: shortType(line.type),
      comment: line.comment,
      fingerprint,
      inAgent: true
    })
  }
  for (const path of preferred) {
    if (!existsSync(path) || existsSync(`${path}.pub`)) continue
    keys.push({
      id: path, name: path.replaceAll('\\', '/').split('/').at(-1)!, path, publicKey: null,
      type: '', comment: '', fingerprint: null, inAgent: false
    })
  }
  const rank = (key: SshKey): number => {
    const index = key.path ? preferred.findIndex((path) => samePath(path, key.path!)) : -1
    return index < 0 ? preferred.length : index
  }
  return keys.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

function assertTarget(target: SshTarget): void {
  // A remote's address comes from outside, and a value starting with a dash would be read as an option.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]*$/.test(target.host)) throw new Error(`Некорректный адрес сервера: ${target.host}`)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(target.user)) throw new Error(`Некорректное имя пользователя: ${target.user}`)
}

function targetArgs(target: SshTarget): string[] {
  assertTarget(target)
  return ['-l', target.user, ...(target.port ? ['-p', String(target.port)] : []), '--', target.host]
}

/** Confirms the server itself. Offers no key, and asks the person about a server seen for the first time. */
export async function probeHost(target: SshTarget): Promise<HostProbe> {
  const { ssh } = await findTools()
  const result = await runTool(ssh, [
    ...configArgs(), '-T',
    '-o', 'PreferredAuthentications=none', '-o', 'NumberOfPasswordPrompts=0', '-o', 'ConnectTimeout=10',
    ...targetArgs(target)
  ], { timeoutMs: 5 * 60_000 })
  if (result.missing) return 'no-ssh'
  const issue = classifyAccessError(result.stderr)
  if (issue === 'host-changed') return 'changed'
  if (issue === 'host-unknown') return 'rejected'
  if (issue === 'offline') return 'offline'
  return 'reachable'
}

const GREETINGS = [
  /^Hi there, ([^!\s]+)!/m,
  /^Hi ([^!\s]+)! You've successfully authenticated/m,
  /^Welcome to GitLab, @([^!\s]+)!/m,
  /logged in as ([^\s.]+)/,
  /authenticated (?:as|via ssh key as) ([^\s.!]+)/i
]

function readAccount(output: string): string | null {
  const text = output.split('\n').filter((line) => !line.startsWith('debug')).join('\n')
  for (const pattern of GREETINGS) {
    const match = pattern.exec(text)
    if (match) return match[1]
  }
  return null
}

export function statusFromOutput(output: string): KeyStatus {
  const issue = classifyAccessError(output)
  if (issue === 'no-key') return /Server accepts key/.test(output) ? { state: 'locked' } : { state: 'rejected' }
  if (issue === 'host-changed' || issue === 'host-unknown' || issue === 'offline' || issue === 'ssh-missing') {
    return { state: 'failed', issue, message: output.split('\n').filter((line) => !line.startsWith('debug')).join('\n').trim() }
  }
  if (/Authenticated to /.test(output)) return { state: 'connected', account: readAccount(output) }
  return { state: 'failed', issue, message: output.split('\n').filter((line) => !line.startsWith('debug')).join('\n').trim() }
}

/** Saves an agent key's public part, because ssh picks such a key by this file. */
async function publicFileFor(key: SshKey, dir: string): Promise<string> {
  const path = join(dir, `chronicle-${key.fingerprint!.slice(7, 19).replace(/[^A-Za-z0-9]/g, '')}.pub`)
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${key.publicKey}\n`)
  }
  return path
}

async function identityPath(key: SshKey): Promise<string> {
  if (key.path) return key.path
  if (!key.publicKey || !key.fingerprint) throw new Error('У этого ключа нет ни файла, ни публичной части')
  return publicFileFor(key, sshDir())
}

/**
 * Tries one key alone. `interactive` lets ssh ask for the key's password; without it the check is
 * silent and reports a key the server knows as locked.
 */
export async function checkKey(key: SshKey, target: SshTarget, interactive = false): Promise<KeyStatus> {
  if (!key.publicKey) return { state: 'unknown' }
  const { ssh } = await findTools()
  const result = await runTool(ssh, [
    ...configArgs(), '-v', '-T',
    '-i', await identityPath(key),
    '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10',
    ...(interactive ? [] : ['-o', 'BatchMode=yes']),
    ...targetArgs(target)
  ], { timeoutMs: interactive ? 5 * 60_000 : CHECK_TIMEOUT_MS })
  if (result.missing) return { state: 'failed', issue: 'ssh-missing', message: result.stderr }
  return statusFromOutput(`${result.stderr}\n${result.stdout}`)
}

/** Recovers a missing `.pub` file. A protected key asks for its password. */
export async function derivePublicKey(path: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`Нет такого ключа: ${path}`)
  const { keygen } = await findTools()
  const result = await runTool(keygen, ['-y', '-f', path], { timeoutMs: 5 * 60_000 })
  const line = parsePublicLine(result.stdout)
  if (result.code !== 0 || !line) throw new Error(`Не удалось прочитать ключ. ${result.stderr.trim()}`.trim())
  const target = `${path}.pub`
  if (!existsSync(target)) await writeFile(target, `${result.stdout.trim()}\n`)
}

/** Checks a key's password without trying it on a server. */
export async function verifyPassphrase(path: string, value: string, askpass: AskpassServer): Promise<boolean> {
  const { keygen } = await findTools()
  const secret = askpass.oneShot(value)
  try {
    const result = await runTool(keygen, ['-y', '-f', path], { env: secret.env, timeoutMs: CHECK_TIMEOUT_MS })
    return !/incorrect passphrase|bad passphrase/i.test(result.stderr)
  } finally {
    secret.dispose()
  }
}

function freeKeyPath(): string {
  const dir = sshDir()
  const free = (path: string): boolean => !existsSync(path) && !existsSync(`${path}.pub`)
  const standard = join(dir, 'id_ed25519')
  if (free(standard)) return standard
  for (let index = 1; ; index++) {
    const candidate = join(dir, index === 1 ? 'id_ed25519_chronicle' : `id_ed25519_chronicle_${index}`)
    if (free(candidate)) return candidate
  }
}

const MIN_PASSPHRASE = 5

/** Creates a key under a name nothing else uses, so an existing key can never be overwritten. */
export async function createKey(passphrase: string, askpass: AskpassServer | null): Promise<string> {
  if (passphrase && passphrase.length < MIN_PASSPHRASE) throw new Error(`Пароль ключа должен быть не короче ${MIN_PASSPHRASE} символов`)
  const path = freeKeyPath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const { keygen } = await findTools()
  const comment = `${userInfo().username}@${hostname()}`
  const base = ['-q', '-t', 'ed25519', '-f', path, '-C', comment]
  let result: ToolResult
  if (passphrase) {
    if (!askpass) throw new Error('Пароль ключа передать не удалось')
    const secret = askpass.oneShot(passphrase)
    try {
      result = await runTool(keygen, base, { env: secret.env, timeoutMs: CHECK_TIMEOUT_MS })
    } finally {
      secret.dispose()
    }
  } else {
    result = await runTool(keygen, [...base, '-N', ''], { timeoutMs: CHECK_TIMEOUT_MS })
  }
  if (result.missing) throw new Error('На компьютере не найден ssh-keygen. Установи Git или OpenSSH и повтори.')
  if (result.code !== 0 || !existsSync(`${path}.pub`)) throw new Error(`Не удалось создать ключ. ${result.stderr.trim()}`.trim())
  return path
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** The command that makes git use exactly this key. git runs it through sh on every system. */
export function sshCommandFor(identity: string): string {
  const config = configArgs().map((arg) => shellQuote(arg.replaceAll('\\', '/')))
  return ['ssh', ...config, '-i', shellQuote(identity.replaceAll('\\', '/')), '-o', 'IdentitiesOnly=yes'].join(' ')
}

/** Ties a repository to a key, in that repository's settings only. */
export async function useKeyForRepo(cwd: string, key: SshKey): Promise<void> {
  await gitLine(cwd, ['config', '--local', 'core.sshCommand', sshCommandFor(await identityPath(key))])
}

export async function clearRepoKey(cwd: string): Promise<void> {
  await runGit(cwd, ['config', '--local', '--unset', 'core.sshCommand'], { okCodes: [5] })
}

/** The key this repository was tied to, if the setting was written here. */
export async function repoKeyPath(cwd: string): Promise<string | null> {
  const { stdout, code } = await runGit(cwd, ['config', '--local', '--get', 'core.sshCommand'], { okCodes: [1] })
  if (code !== 0) return null
  const match = /-i '((?:[^']|'\\'')+)'/.exec(stdout.toString('utf8'))
  return match ? match[1].replaceAll(`'\\''`, "'") : null
}

export interface RemoteCheck {
  ok: boolean
  issue: AccessIssue | null
  message: string
}

/**
 * Asks the server for its branches with the settings a real push would use. `url` may be a remote's
 * name inside `cwd`. `keyPath` tries a key without saving anything.
 */
export async function checkRemote(cwd: string | null, url: string, keyPath?: string): Promise<RemoteCheck> {
  try {
    await runGit(cwd ?? tmpdir(), ['ls-remote', '--heads', '--', url], {
      env: keyPath ? { GIT_SSH_COMMAND: sshCommandFor(keyPath) } : {},
      timeoutMs: 5 * 60_000
    })
    return { ok: true, issue: null, message: '' }
  } catch (error) {
    const message = error instanceof GitError ? error.stderr || error.message : (error as Error).message
    return { ok: false, issue: classifyAccessError(message), message: message.trim() }
  }
}
