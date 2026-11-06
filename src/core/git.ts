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
}

export interface RunResult {
  stdout: Buffer
  stderr: string
  code: number
}

let gitBinary = process.env.CHRONICLE_GIT || 'git'
let baseEnv: NodeJS.ProcessEnv = process.env

export function configureGit(options: {
  binary?: string
  env?: NodeJS.ProcessEnv
}): void {
  if (options.binary) gitBinary = options.binary
  if (options.env) baseEnv = options.env
}

export function spawnGit(cwd: string, args: string[], env?: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(gitBinary, args, {
    cwd,
    windowsHide: true,
    env: {
      ...baseEnv,
      LC_ALL: 'C',
      LANGUAGE: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_MERGE_AUTOEDIT: 'no',
      ...env
    }
  })
}

export function runGit(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnGit(cwd, args, options.env)
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      reject(new GitError(`Не удалось запустить git: ${error.message}`, args, null, ''))
    })
    child.on('close', (code) => {
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

export const MIN_GIT_VERSION: [number, number] = [2, 45]

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
