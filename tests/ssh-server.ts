import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection, type ParsedKey } from 'ssh2'
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
  return ['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd'].find((path) => existsSync(path)) ?? null
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
  // Git for Windows comes without sshd, but its ssh client is what has to be tested there.
  if (process.platform === 'win32' || process.env.CHRONICLE_TEST_NODE_SSH) return startNodeSshServer(dir)
  const sshd = findSshd()
  if (!sshd) {
    sshdFailure = 'no sshd found in the usual paths'
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
    'UsePAM no',
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

/** The same behaviour as the real sshd above, for systems that have none. Clients cannot tell. */
async function startNodeSshServer(dir: string): Promise<SshServer> {
  const hostKey = join(dir, 'host_key')
  execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', hostKey, '-N', ''])
  const allowed: ParsedKey[] = []
  const clients = new Set<Connection>()
  const server = new Server({ hostKeys: [readFileSync(hostKey)] }, (client) => {
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', (context) => {
      if (context.method !== 'publickey') return context.reject(['publickey'])
      const key = allowed.find((item) => item.type === context.key.algo && item.getPublicSSH().equals(context.key.data))
      if (!key) return context.reject(['publickey'])
      if (context.signature && key.verify(context.blob!, context.signature, context.hashAlgo) !== true) return context.reject(['publickey'])
      context.accept()
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write("Hi tester! You've successfully authenticated, but there is no shell access.\r\n")
          stream.exit(1)
          stream.end()
        })
        session.on('exec', (accept, reject, info) => {
          const match = /^git[- ](upload-pack|receive-pack) '?(.+?)'?$/.exec(info.command)
          if (!match) return reject()
          const stream = accept()
          const path = match[2].replace(/^\/([a-zA-Z])\//, '$1:/').replace(/^\/([a-zA-Z]:)/, '$1')
          const child = spawn('git', [match[1], path], { windowsHide: true })
          child.stdout.pipe(stream, { end: false })
          child.stderr.pipe(stream.stderr, { end: false })
          stream.pipe(child.stdin)
          child.stdin.on('error', () => {})
          child.on('close', (code) => {
            stream.exit(code ?? 1)
            stream.end()
          })
        })
      })
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
  const user = userInfo().username
  return {
    port,
    user,
    authorize: (publicKey) => {
      const parsed = utils.parseKey(publicKey.trim())
      if (parsed instanceof Error) throw parsed
      allowed.push(Array.isArray(parsed) ? parsed[0] : parsed)
    },
    url: (path) => `ssh://${user}@127.0.0.1:${port}/${serverPath(path).replace(/^\/+/, '')}`,
    stop: () => {
      for (const client of clients) client.end()
      server.close()
    }
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
