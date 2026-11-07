import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface RunOptions {
  input?: string | Buffer
  /** Exit codes treated as success, in addition to 0. */
  okCodes?: number[]
  env?: Record<string, string>
  /** Kills the command after this long. Only for checks: a real push may take a while. */
  timeoutMs?: number
}

export interface RunResult {
  stdout: Buffer
  stderr: string
  code: number
}

let gitBinary = process.env.CHRONICLE_GIT || 'git'
let baseEnv: NodeJS.ProcessEnv = process.env
let promptEnv: () => Record<string, string> = () => ({})
const quiet = new AsyncLocalStorage<boolean>()

export function configureGit(options: {
  binary?: string
  env?: NodeJS.ProcessEnv
  promptEnv?: () => Record<string, string>
}): void {
  if (options.binary) gitBinary = options.binary
  if (options.env) baseEnv = options.env
  if (options.promptEnv) promptEnv = options.promptEnv
}

/** Runs an action that nobody is watching, such as a timed publish: it must not wait for answers. */
export function withoutPrompts<T>(action: () => Promise<T>): Promise<T> {
  return quiet.run(true, action)
}

/** The environment for git and ssh. They ask for passwords through the app, never a terminal. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    LC_ALL: 'C',
    LANGUAGE: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...promptEnv(),
    ...(quiet.getStore() ? { CHRONICLE_ASKPASS_MODE: 'background' } : {}),
    ...extra
  }
}

export function spawnGit(cwd: string, args: string[], env?: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(gitBinary, args, {
    cwd,
    windowsHide: true,
    env: childEnv({ GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', ...env })
  })
}

export function runGit(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(cwd, args, options.env)
    const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : null
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(new GitError(`Не удалось запустить git: ${error.message}`, args, null, ''))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8')
      const exit = code ?? -1
      if (exit === 0 || options.okCodes?.includes(exit)) {
        resolve({ stdout: Buffer.concat(out), stderr, code: exit })
      } else {
        const detail = stderr.trim() || Buffer.concat(out).toString('utf8').trim()
        reject(new GitError(detail || `git ${args[0]} завершился с кодом ${exit}`, args, code, stderr))
      }
    })
    child.stdin.on('error', () => {})
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export async function git(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return (await runGit(cwd, args, options)).stdout.toString('utf8')
}

export async function gitLine(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  return (await git(cwd, args, options)).trim()
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const { code } = await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [1] })
  return code === 0
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
  const { stdout, code } = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [1] })
  return code === 0 ? stdout.toString('utf8').trim() : null
}

const MIN_GIT_VERSION: [number, number] = [2, 45]

export async function checkGitVersion(): Promise<string> {
  const text = await gitLine(process.cwd(), ['--version'])
  const match = /(\d+)\.(\d+)/.exec(text)
  if (!match) throw new Error(`Не удалось определить версию git: ${text}`)
  const [major, minor] = [Number(match[1]), Number(match[2])]
  if (major < MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor < MIN_GIT_VERSION[1])) {
    throw new Error(`Нужен git ${MIN_GIT_VERSION.join('.')} или новее, установлен ${text}`)
  }
  return text
}
