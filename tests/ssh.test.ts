import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AskpassServer } from '../src/core/askpass'
import { configureGit, git, gitLine, withoutPrompts } from '../src/core/git'
import { cloneRepository } from '../src/core/ops'
import { PromptBroker, type SecretStore } from '../src/core/prompt-broker'
import { checkKey, checkRemote, clearRepoKey, createKey, derivePublicKey, listKeys, probeHost, repoKeyPath, useKeyForRepo, verifyPassphrase, type SshKey } from '../src/core/ssh'
import { classifyAccessError, type AccessPrompt, type PromptReply, type SshTarget } from '../src/shared/access'
import { startGitHttpServer } from './git-http-server'
import { commitFile, createRepo, tempDir } from './helpers'
import { sshdFailure, sshTool, startSshServer, writeClientConfig, type SshServer } from './ssh-server'

const asked: AccessPrompt[] = []
let answer: (prompt: AccessPrompt) => PromptReply | null = () => null
const saved = new Map<string, string>()
const store: SecretStore = {
  available: () => true,
  get: (key) => saved.get(key) ?? null,
  set: async (key, value) => void saved.set(key, value),
  delete: async (key) => void saved.delete(key)
}
const askpass = new AskpassServer((request) => broker.handle(request))
const broker = new PromptBroker(async (prompt) => {
  asked.push(prompt)
  return answer(prompt)
}, store, (path, value) => verifyPassphrase(path, value, askpass))
const previous = { ...process.env }

beforeAll(async () => {
  await askpass.start(join(tempDir(), 'helper dir'))
  configureGit({ promptEnv: () => askpass.env() })
  // Keeps test passwords out of the real keychain of whoever runs the tests.
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  // ssh-add would otherwise list the real keys of whoever runs the tests.
  delete process.env.SSH_AUTH_SOCK
  const globalConfig = join(tempDir(), 'gitconfig')
  writeFileSync(globalConfig, '')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
})

afterAll(async () => {
  configureGit({ promptEnv: () => ({}) })
  await askpass.stop()
  for (const key of ['SSH_AUTH_SOCK', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'CHRONICLE_SSH_HOME', 'CHRONICLE_SSH_CONFIG']) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

beforeEach(() => {
  asked.length = 0
  saved.clear()
  broker.clearSession()
  answer = () => null
})

describe('asking through the app over HTTP', () => {
  let http: Awaited<ReturnType<typeof startGitHttpServer>> & { server: Server }
  let bare: string

  beforeAll(async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    bare = tempDir()
    await git(bare, ['clone', '-q', '--bare', dir, '.'])
    http = await startGitHttpServer(bare, 'ann', 'пароль с пробелом')
  })

  afterAll(() => {
    http.server.close()
  })

  it('passes a login from the dialog to git', async () => {
    answer = (prompt) => ({ answer: prompt.kind === 'username' ? 'ann' : 'пароль с пробелом' })
    expect(await checkRemote(null, http.url)).toMatchObject({ ok: true })
    expect(asked.map((prompt) => prompt.kind)).toEqual(['username', 'password'])
    expect(asked[1].hidden).toBe(true)
  })

  it('reports a cancelled dialog as a missing login', async () => {
    answer = () => null
    const result = await checkRemote(null, http.url)
    expect(result).toMatchObject({ ok: false, issue: 'https-auth' })
  })

  it('reports a wrong password', async () => {
    answer = (prompt) => ({ answer: prompt.kind === 'username' ? 'ann' : 'wrong' })
    expect(await checkRemote(null, http.url)).toMatchObject({ ok: false, issue: 'https-auth' })
  })

  it('does not ask when nobody is watching', async () => {
    const result = await withoutPrompts(() => checkRemote(null, http.url))
    expect(asked).toHaveLength(0)
    expect(result).toMatchObject({ ok: false, issue: 'https-auth' })
  })
})

const root = tempDir()
const home = join(root, 'home')
const serverDir = join(root, 'server')
mkdirSync(home)
mkdirSync(serverDir)
const server: SshServer | null = await startSshServer(serverDir)

it.runIf(process.env.CHRONICLE_REQUIRE_SSHD)('has a real ssh server to test against', () => {
  expect(sshdFailure).toBe('')
})

describe.skipIf(!server)('keys against a real ssh server', () => {
  const target = (): SshTarget => ({ host: '127.0.0.1', user: server!.user, port: server!.port })
  const known = join(serverDir, 'known_hosts')
  const keyPath = (name: string): string => join(home, '.ssh', name)
  const find = async (name: string): Promise<SshKey> => (await listKeys('127.0.0.1')).find((key) => key.name === name)!
  let bare: string
  let config: string

  beforeAll(async () => {
    process.env.CHRONICLE_SSH_HOME = home
    config = writeClientConfig(serverDir, home)
    process.env.CHRONICLE_SSH_CONFIG = config
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\tsshCommand = ssh -F '${config.replaceAll('\\', '/')}'\n`)
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    bare = join(serverDir, 'project.git')
    mkdirSync(bare)
    await git(bare, ['clone', '-q', '--bare', dir, '.'])
  })

  afterAll(() => {
    server?.stop()
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, '')
  })

  afterEach(() => {
    answer = () => null
  })

  it('finds no keys on a clean computer, without creating anything', async () => {
    expect(await listKeys('127.0.0.1')).toEqual([])
    expect(existsSync(join(home, '.ssh'))).toBe(false)
  })

  it('asks about a new server and respects a refusal', async () => {
    answer = () => null
    expect(await probeHost(target())).toBe('rejected')
    expect(asked[0]).toMatchObject({ kind: 'host-key' })
    expect(asked[0].fingerprint).toMatch(/^SHA256:/)
    expect(existsSync(known)).toBe(false)
  })

  it('stays silent in a quiet key check of an unknown server', async () => {
    const path = await createKey('', askpass)
    const status = await checkKey(await find('id_ed25519'), target())
    expect(status).toMatchObject({ state: 'failed', issue: 'host-unknown' })
    expect(asked.filter((prompt) => prompt.kind === 'host-key').length).toBe(0)
    expect(path).toBe(keyPath('id_ed25519'))
  })

  it('remembers a server the person accepted', async () => {
    answer = () => ({ answer: 'yes' })
    expect(await probeHost(target())).toBe('reachable')
    expect(readFileSync(known, 'utf8')).toContain('[127.0.0.1]')
    asked.length = 0
    expect(await probeHost(target())).toBe('reachable')
    expect(asked).toHaveLength(0)
  })

  it('warns about a changed server key and never answers for the person', async () => {
    const original = readFileSync(known, 'utf8')
    const other = join(serverDir, 'other_host_key')
    execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', other, '-N', ''])
    const fake = readFileSync(`${other}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(known, `[127.0.0.1]:${server!.port} ${fake}\n`)
    answer = () => ({ answer: 'yes' })
    expect(await probeHost(target())).toBe('changed')
    writeFileSync(known, original)
  })

  it('reports an unreachable server as such', async () => {
    expect(await probeHost({ host: '127.0.0.1', user: 'git', port: 1 })).toBe('offline')
  })

  it('refuses a server address that would be read as an option', async () => {
    await expect(probeHost({ host: '-oProxyCommand=touch /tmp/x', user: 'git' })).rejects.toThrow('Некорректный адрес')
    await expect(probeHost({ host: 'host', user: '-oProxyCommand=x' })).rejects.toThrow('Некорректное имя')
  })

  it('never overwrites an existing key', async () => {
    const before = readFileSync(keyPath('id_ed25519'), 'utf8')
    const second = await createKey('', askpass)
    expect(second).toBe(keyPath('id_ed25519_chronicle'))
    const third = await createKey('', askpass)
    expect(third).toBe(keyPath('id_ed25519_chronicle_2'))
    expect(readFileSync(keyPath('id_ed25519'), 'utf8')).toBe(before)
  })

  it('lists keys with ssh defaults first and a real fingerprint', async () => {
    const keys = await listKeys('127.0.0.1')
    expect(keys.map((key) => key.name)).toEqual(['id_ed25519', 'id_ed25519_chronicle', 'id_ed25519_chronicle_2'])
    const fromTool = execFileSync(sshTool('ssh-keygen'), ['-lf', `${keyPath('id_ed25519')}.pub`], { encoding: 'utf8' })
    expect(fromTool).toContain(keys[0].fingerprint)
    expect(keys[0]).toMatchObject({ type: 'ed25519', inAgent: false })
    expect(keys[0].publicKey).toBe(readFileSync(`${keyPath('id_ed25519')}.pub`, 'utf8').trim())
  })

  it('sees when a site starts accepting a key, and who it belongs to', async () => {
    const key = await find('id_ed25519')
    expect(await checkKey(key, target())).toEqual({ state: 'rejected' })
    server!.authorize(key.publicKey!)
    expect(await checkKey(key, target())).toEqual({ state: 'connected', account: 'tester' })
  })

  it('pushes and pulls with a plain key', async () => {
    const url = server!.url(bare)
    expect(await checkRemote(null, url)).toMatchObject({ ok: true })
    const parent = tempDir()
    const dir = await cloneRepository(url, parent, 'clone')
    await git(dir, ['config', 'user.name', 'T'])
    await git(dir, ['config', 'user.email', 't@example.com'])
    await commitFile(dir, 'b.txt', '2\n', 'two')
    await git(dir, ['push', '-q', 'origin', 'HEAD'])
    expect(await gitLine(bare, ['log', '-1', '--format=%s'])).toBe('two')
  })

  describe('a key with a password', () => {
    const passphrase = 'длинный пароль 1'
    let locked: SshKey

    beforeAll(async () => {
      // A separate home, so the plain keys above cannot help.
      const lockedHome = join(root, 'locked-home')
      mkdirSync(lockedHome)
      process.env.CHRONICLE_SSH_HOME = lockedHome
      process.env.CHRONICLE_SSH_CONFIG = writeClientConfig(serverDir, lockedHome)
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\tsshCommand = ssh -F '${process.env.CHRONICLE_SSH_CONFIG.replaceAll('\\', '/')}'\n`)
      const path = await createKey(passphrase, askpass)
      expect(path).toBe(join(lockedHome, '.ssh', 'id_ed25519'))
      locked = (await listKeys('127.0.0.1'))[0]
      server!.authorize(locked.publicKey!)
    })

    afterAll(() => {
      process.env.CHRONICLE_SSH_HOME = home
      process.env.CHRONICLE_SSH_CONFIG = config
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\tsshCommand = ssh -F '${config.replaceAll('\\', '/')}'\n`)
    })

    it('really encrypts the file and keeps the password off the command line', () => {
      expect(() => execFileSync(sshTool('ssh-keygen'), ['-y', '-P', '', '-f', locked.path!], { stdio: 'pipe' })).toThrow()
    })

    it('shows as locked without asking anything', async () => {
      expect(await checkKey(locked, target())).toEqual({ state: 'locked' })
      expect(asked).toHaveLength(0)
    })

    it('asks for the password, then connects', async () => {
      answer = () => ({ answer: passphrase })
      expect(await checkKey(locked, target(), true)).toEqual({ state: 'connected', account: 'tester' })
      expect(asked[0]).toMatchObject({ kind: 'passphrase', hidden: true, canRemember: true })
      expect(asked[0].keyPath).toContain('id_ed25519')
    })

    it('asks again after a wrong password, and a right one still works', async () => {
      const replies = ['wrong', passphrase]
      answer = () => ({ answer: replies.shift()! })
      expect(await checkKey(locked, target(), true)).toEqual({ state: 'connected', account: 'tester' })
      expect(asked).toHaveLength(2)
      expect(asked[1].retry).toBe(true)
    })

    it('stays locked when the person cancels', async () => {
      answer = () => null
      expect(await checkKey(locked, target(), true)).toEqual({ state: 'locked' })
    })

    it('does a whole real push through the password dialog, asking once', async () => {
      answer = () => ({ answer: passphrase })
      const parent = tempDir()
      const dir = await cloneRepository(server!.url(bare), parent, 'clone')
      await git(dir, ['config', 'user.name', 'T'])
      await git(dir, ['config', 'user.email', 't@example.com'])
      await commitFile(dir, 'c.txt', '3\n', 'three')
      await git(dir, ['fetch', '-q', 'origin'])
      await git(dir, ['push', '-q', 'origin', 'HEAD'])
      expect(await gitLine(bare, ['log', '-1', '--format=%s'])).toBe('three')
      expect(asked).toHaveLength(1)
    })

    it('fails clearly when a timed publish has no way to get the password', async () => {
      const result = await withoutPrompts(() => checkRemote(null, server!.url(bare)))
      expect(asked).toHaveLength(0)
      expect(result).toMatchObject({ ok: false, issue: 'no-key' })
    })

    it('works unattended once the person chose to remember the password', async () => {
      answer = () => ({ answer: passphrase, remember: true })
      expect(await checkRemote(null, server!.url(bare))).toMatchObject({ ok: true })
      expect(saved.size).toBe(1)
      broker.clearSession()
      asked.length = 0
      expect(await withoutPrompts(() => checkRemote(null, server!.url(bare)))).toMatchObject({ ok: true })
      expect(asked).toHaveLength(0)
    })

    it('recovers a missing public file with the password', async () => {
      const path = locked.path!
      const publicFile = `${path}.pub`
      const original = readFileSync(publicFile, 'utf8')
      renameSync(publicFile, `${publicFile}.saved`)
      const listed = (await listKeys('127.0.0.1')).find((key) => key.path === path)!
      expect(listed.publicKey).toBeNull()
      expect(await checkKey(listed, target())).toEqual({ state: 'unknown' })
      answer = () => ({ answer: passphrase })
      await derivePublicKey(path)
      expect(readFileSync(publicFile, 'utf8').trim().split(' ').slice(0, 2)).toEqual(original.trim().split(' ').slice(0, 2))
      expect((await listKeys('127.0.0.1')).find((key) => key.path === path)?.publicKey).toBeTruthy()
    })
  })

  describe('a key with an unusual name', () => {
    let special: SshKey
    let repo: string

    beforeAll(async () => {
      const specialHome = join(root, 'special home')
      mkdirSync(join(specialHome, '.ssh'), { recursive: true })
      process.env.CHRONICLE_SSH_HOME = specialHome
      process.env.CHRONICLE_SSH_CONFIG = writeClientConfig(serverDir, specialHome)
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\tsshCommand = ssh -F '${process.env.CHRONICLE_SSH_CONFIG.replaceAll('\\', '/')}'\n`)
      const keyFile = join(specialHome, '.ssh', "work's key")
      execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', keyFile, '-N', '', '-C', 'work'])
      special = (await listKeys('127.0.0.1'))[0]
      server!.authorize(special.publicKey!)
      repo = await createRepo()
      await git(repo, ['remote', 'add', 'origin', server!.url(bare)])
    })

    afterAll(() => {
      process.env.CHRONICLE_SSH_HOME = home
      process.env.CHRONICLE_SSH_CONFIG = config
      writeFileSync(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\tsshCommand = ssh -F '${config.replaceAll('\\', '/')}'\n`)
    })

    it('is found and works when checked on its own', async () => {
      expect(special.name).toBe("work's key")
      expect(await checkKey(special, target())).toEqual({ state: 'connected', account: 'tester' })
    })

    it('is not tried by ssh without being chosen', async () => {
      expect(await checkRemote(repo, 'origin')).toMatchObject({ ok: false, issue: 'no-key' })
    })

    it('can be tried for a clone without saving anything', async () => {
      expect(await checkRemote(null, server!.url(bare), special.path!)).toMatchObject({ ok: true })
    })

    it('works for one repository once chosen, and can be cleared', async () => {
      await useKeyForRepo(repo, special)
      expect(await repoKeyPath(repo)).toBe(special.path!.replaceAll('\\', '/'))
      expect(await checkRemote(repo, 'origin')).toMatchObject({ ok: true })
      await clearRepoKey(repo)
      expect(await repoKeyPath(repo)).toBeNull()
      expect(await checkRemote(repo, 'origin')).toMatchObject({ ok: false })
      await clearRepoKey(repo)
    })
  })

  describe.skipIf(process.platform === 'win32')('a key held only by an agent', () => {
    let agent: ReturnType<typeof spawn>

    afterAll(() => {
      agent?.kill()
      delete process.env.SSH_AUTH_SOCK
      process.env.CHRONICLE_SSH_HOME = home
      process.env.CHRONICLE_SSH_CONFIG = config
    })

    it('is found and checked with no private file on disk', async () => {
      const dir = tempDir()
      const socket = join(dir, 'a.sock')
      agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' })
      await expect.poll(() => existsSync(socket)).toBe(true)
      process.env.SSH_AUTH_SOCK = socket
      const keyFile = join(dir, 'token')
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-f', keyFile, '-N', '', '-C', 'hardware token'])
      execFileSync('ssh-add', ['-q', keyFile], { env: { ...process.env } })
      server!.authorize(readFileSync(`${keyFile}.pub`, 'utf8'))
      const agentHome = join(root, 'agent-home')
      mkdirSync(join(agentHome, '.ssh'), { recursive: true })
      process.env.CHRONICLE_SSH_HOME = agentHome
      process.env.CHRONICLE_SSH_CONFIG = writeClientConfig(serverDir, agentHome, socket)
      const [key] = await listKeys('127.0.0.1')
      expect(key).toMatchObject({ name: 'hardware token', path: null, inAgent: true })
      expect(await checkKey(key, target())).toEqual({ state: 'connected', account: 'tester' })
    })
  })

  it('reads a refusal the same way the interface will', async () => {
    const message = (await checkRemote(null, 'ssh://nobody-here@127.0.0.1:1/x.git')).message
    expect(classifyAccessError(message)).toBe('offline')
  })
})
