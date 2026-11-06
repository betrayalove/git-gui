import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { gitUsrBin } from '../src/core/ssh'

/** Why the last start failed, so a required server that is missing explains itself. */
export let sshdFailure = ''

export interface SshServer {
  port: number
  user: string
  authorize: (publicKey: string) => void
  url: (path: string) => string
  stop: () => void
}

/** ssh tools that come with Git on Windows, or the system's elsewhere. */
export function sshTool(name: string): string {
  if (process.platform !== 'win32') return name
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  const bin = gitUsrBin(execPath)
  if (!bin) throw new Error(`No ssh tools found near ${execPath}`)
  return join(bin, `${name}.exe`)
}

function findSshd(): string | null {
  const candidates = process.platform === 'win32' ? [sshTool('sshd')] : ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd']
  return candidates.find((path) => existsSync(path)) ?? null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })
}

function posix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** How the shell on the server side spells a path. On Windows that is Git's sh, which writes C: as /c. */
function serverPath(path: string): string {
  return posix(path).replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`)
}

/**
 * Starts a real sshd for this user on a free port. Connecting with no command greets like GitHub
 * does; a command runs normally, so git can really push and fetch. Null when no sshd is available.
 */
export async function startSshServer(dir: string): Promise<SshServer | null> {
  const sshd = findSshd()
  if (!sshd) {
    sshdFailure = `no sshd found, looked for ${process.platform === 'win32' ? sshTool('sshd') : 'the usual paths'}`
    return null
  }
  const hostKey = join(dir, 'host_key')
  execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', hostKey, '-N', ''])
  const authorized = join(dir, 'authorized_keys')
  writeFileSync(authorized, '')
  const force = join(dir, 'force.sh')
  writeFileSync(force, [
    '#!/bin/sh',
    'if [ -z "$SSH_ORIGINAL_COMMAND" ]; then',
    `  echo "Hi tester! You've successfully authenticated, but there is no shell access."`,
    '  exit 1',
    'fi',
    'exec /bin/sh -c "$SSH_ORIGINAL_COMMAND"',
    ''
  ].join('\n'), { mode: 0o755 })
  const port = await freePort()
  const config = join(dir, 'sshd_config')
  writeFileSync(config, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${posix(hostKey)}`,
    `AuthorizedKeysFile ${posix(authorized)}`,
    `ForceCommand ${posix(force)}`,
    `PidFile ${posix(join(dir, 'sshd.pid'))}`,
    'StrictModes no',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'UseDNS no',
    ...(process.platform === 'win32' ? [] : ['UsePAM no']),
    'LogLevel ERROR',
    ''
  ].join('\n'))
  // Newer sshd refuses a source for a while after failed logins, which is what these tests do on purpose.
  try {
    execFileSync(sshd, ['-t', '-f', config, '-o', 'PerSourcePenalties=no'], { stdio: 'ignore' })
    appendFileSync(config, 'PerSourcePenalties no\n')
  } catch {
    // Older versions do not know the option and have no such limit.
  }
  const child: ChildProcess = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let failure = ''
  child.stderr?.on('data', (chunk: Buffer) => { failure += chunk.toString() })
  child.on('error', (error) => { failure += error.message })
  const ready = await new Promise<boolean>((resolve) => {
    const started = Date.now()
    const attempt = (): void => {
      if (child.exitCode !== null) return resolve(false)
      const socket = createServer()
      socket.once('error', () => resolve(true))
      socket.listen(port, '127.0.0.1', () => socket.close(() => {
        if (Date.now() - started > 8000) resolve(false)
        else setTimeout(attempt, 100)
      }))
    }
    attempt()
  })
  if (!ready) {
    child.kill()
    sshdFailure = `${sshd} exited with ${child.exitCode}: ${failure.trim()}`
    return null
  }
  const user = userInfo().username
  return {
    port,
    user,
    authorize: (publicKey) => appendFileSync(authorized, `${publicKey.trim()}\n`),
    url: (path) => `ssh://${user}@127.0.0.1:${port}/${serverPath(path).replace(/^\/+/, '')}`,
    stop: () => void child.kill()
  }
}

/** A client configuration that keeps ssh away from the real ~/.ssh and agent of whoever runs the tests. */
export function writeClientConfig(dir: string, home: string, agentSocket?: string): string {
  const path = join(dir, agentSocket ? 'client_config_agent' : 'client_config')
  const ssh = posix(join(home, '.ssh'))
  writeFileSync(path, [
    'Host *',
    `  UserKnownHostsFile "${posix(join(dir, 'known_hosts'))}"`,
    '  GlobalKnownHostsFile /dev/null',
    `  IdentityAgent ${agentSocket ? posix(agentSocket) : 'none'}`,
    `  IdentityFile "${ssh}/id_ed25519"`,
    `  IdentityFile "${ssh}/id_rsa"`,
    ''
  ].join('\n'))
  return path
}
