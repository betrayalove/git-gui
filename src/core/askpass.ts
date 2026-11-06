import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface AskpassRequest {
  prompt: string
  /** Nobody is watching, so only an answer known in advance can help. */
  background: boolean
}

export type AskpassHandler = (request: AskpassRequest) => Promise<string | null>

/** The small program git and ssh start to ask a question. It relays it here over a local socket. */
const HELPER = `'use strict'
const net = require('node:net')
const env = process.env
// ssh only announces something here, such as a touch on a security key, and expects no answer.
if (env.SSH_ASKPASS_PROMPT === 'none') process.exit(0)
const socket = net.connect(env.CHRONICLE_ASKPASS_SOCKET)
let data = ''
socket.setEncoding('utf8')
socket.on('connect', () => socket.write(JSON.stringify({
  token: env.CHRONICLE_ASKPASS_TOKEN,
  prompt: process.argv.slice(2).join(' '),
  background: env.CHRONICLE_ASKPASS_MODE === 'background',
  oneShot: env.CHRONICLE_ASKPASS_ONESHOT || null
}) + '\\n'))
socket.on('data', (chunk) => { data += chunk })
socket.on('error', () => process.exit(1))
socket.on('end', () => {
  let answer = null
  try { answer = JSON.parse(data).answer } catch {}
  if (typeof answer !== 'string') process.exit(1)
  process.stdout.write(answer + '\\n', () => process.exit(0))
})
`

// The same script works everywhere: on Windows, git and its ssh run it with the sh that comes with Git.
const SCRIPT = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1
MSYS2_ARG_CONV_EXCL='*'
MSYS_NO_PATHCONV=1
export ELECTRON_RUN_AS_NODE MSYS2_ARG_CONV_EXCL MSYS_NO_PATHCONV
exec "$CHRONICLE_ASKPASS_NODE" "$CHRONICLE_ASKPASS_MAIN" "$@"
`

function forwardSlashes(path: string): string {
  return process.platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * Lets git and ssh ask their questions through the app. The socket is reachable only with a token
 * that exists in the environment of the commands started here, and answers are never written to disk.
 */
export class AskpassServer {
  private server: Server | null = null
  private socketDir: string | null = null
  private address = ''
  private scriptPath = ''
  private mainPath = ''
  private readonly token = randomBytes(24).toString('hex')
  private readonly oneShots = new Map<string, string>()

  constructor(private readonly handler: AskpassHandler) {}

  /** `dir` holds the helper files: they must be real files, because git cannot run them from an archive. */
  async start(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    this.scriptPath = join(dir, 'askpass.sh')
    this.mainPath = join(dir, 'askpass.cjs')
    await writeFile(this.mainPath, HELPER)
    await writeFile(this.scriptPath, SCRIPT)
    await chmod(this.scriptPath, 0o755)
    if (process.platform === 'win32') {
      this.address = `\\\\.\\pipe\\chronicle-askpass-${randomBytes(12).toString('hex')}`
    } else {
      // A short path, because socket paths have a small limit, in a folder only this user can open.
      this.socketDir = await mkdtemp(join(tmpdir(), 'chronicle-'))
      this.address = join(this.socketDir, 'askpass.sock')
    }
    this.server = createServer((socket) => this.serve(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.address, resolve)
    })
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve())
      else resolve()
    })
    this.server = null
    if (this.socketDir) await rm(this.socketDir, { recursive: true, force: true })
  }

  env(): Record<string, string> {
    if (!this.server) return {}
    const script = forwardSlashes(this.scriptPath)
    return {
      GIT_ASKPASS: script,
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: 'force',
      CHRONICLE_ASKPASS_NODE: forwardSlashes(process.execPath),
      CHRONICLE_ASKPASS_MAIN: forwardSlashes(this.mainPath),
      CHRONICLE_ASKPASS_SOCKET: this.address,
      CHRONICLE_ASKPASS_TOKEN: this.token
    }
  }

  /**
   * Hands a known value to one command, so it never appears on a command line where other
   * programs could read it. Call `dispose` when the command ends.
   */
  oneShot(value: string): { env: Record<string, string>; dispose: () => void } {
    const id = randomBytes(12).toString('hex')
    this.oneShots.set(id, value)
    return { env: { CHRONICLE_ASKPASS_ONESHOT: id }, dispose: () => this.oneShots.delete(id) }
  }

  private serve(socket: Socket): void {
    let data = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      data += chunk
      const end = data.indexOf('\n')
      if (end < 0) return
      socket.removeAllListeners('data')
      void this.answer(data.slice(0, end)).then((answer) => socket.end(JSON.stringify({ answer })))
    })
  }

  private async answer(line: string): Promise<string | null> {
    try {
      const request = JSON.parse(line) as { token?: string; prompt?: string; background?: boolean; oneShot?: string | null }
      if (request.token !== this.token) return null
      if (request.oneShot) return this.oneShots.get(request.oneShot) ?? null
      return await this.handler({ prompt: request.prompt ?? '', background: Boolean(request.background) })
    } catch {
      return null
    }
  }
}
