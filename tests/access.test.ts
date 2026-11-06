import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptBroker, normalizeKeyPath, type SecretStore } from '../src/core/prompt-broker'
import { classifyAccessError, parsePrompt, sshKeysPage, targetFromUrl, toSshUrl, type AccessPrompt, type PromptReply } from '../src/shared/access'
import { gitUsrBin, nativePath, statusFromOutput } from '../src/core/ssh'
import { tempDir } from './helpers'

describe('recognizing refused connections', () => {
  it.each([
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'no-key'],
    ['Load key "/Users/me/.ssh/id": incorrect passphrase supplied to decrypt private key', 'passphrase'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'host-unknown'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host-changed'],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'https-auth'],
    ["remote: Support for password authentication was removed on August 13, 2021.\nfatal: Authentication failed for 'https://github.com/a/b.git/'", 'https-auth'],
    ['remote: HTTP Basic: Access denied', 'https-auth'],
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'no-access'],
    ["remote: Permission to a/b.git denied to c.\nfatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403", 'no-access'],
    ['remote: The project you were looking for could not be found', 'no-access'],
    ['ssh: Could not resolve hostname github.com: nodename nor servname provided', 'offline'],
    ['ssh: connect to host github.com port 22: Connection refused', 'offline'],
    ["fatal: unable to access 'https://github.com/a/b/': Failed to connect to github.com port 443", 'offline'],
    ['remote: error: GH006: Protected branch update failed for refs/heads/main.', 'protected'],
    ['remote: GitLab: You are not allowed to force push code to a protected branch on this project.', 'protected'],
    ['error: cannot run ssh: No such file or directory', 'ssh-missing']
  ])('reads %s', (message, issue) => {
    expect(classifyAccessError(message)).toBe(issue)
  })

  it('leaves other failures alone', () => {
    expect(classifyAccessError('error: failed to push some refs: stale info')).toBeNull()
    expect(classifyAccessError('CONFLICT (content): Merge conflict in a.txt')).toBeNull()
  })
})

describe('reading what ssh and git ask', () => {
  it('finds the key in a password question', () => {
    expect(parsePrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ")).toMatchObject({ kind: 'passphrase', hidden: true, keyPath: '/Users/me/.ssh/id_ed25519' })
    expect(parsePrompt("Enter passphrase for key 'C:/Users/me/.ssh/id_rsa': ")).toMatchObject({ kind: 'passphrase', keyPath: 'C:/Users/me/.ssh/id_rsa' })
    expect(parsePrompt('Enter passphrase for "/keys/id": ')).toMatchObject({ kind: 'passphrase', keyPath: '/keys/id' })
    expect(parsePrompt('Enter passphrase: ')).toMatchObject({ kind: 'passphrase', hidden: true })
    expect(parsePrompt('Enter passphrase: ').keyPath).toBeUndefined()
    expect(parsePrompt('Bad passphrase, try again for /keys/id: ')).toMatchObject({ kind: 'passphrase', keyPath: '/keys/id', retry: true })
  })

  it('finds the server and fingerprint in a first connection', () => {
    const text = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? "
    expect(parsePrompt(text)).toMatchObject({ kind: 'host-key', host: 'github.com', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' })
  })

  it('tells HTTPS logins apart', () => {
    expect(parsePrompt("Username for 'https://github.com': ")).toMatchObject({ kind: 'username', hidden: false, host: 'https://github.com' })
    expect(parsePrompt("Password for 'https://me@github.com': ")).toMatchObject({ kind: 'password', hidden: true })
    expect(parsePrompt("me@host's password: ")).toMatchObject({ kind: 'password', hidden: true })
    expect(parsePrompt('Warning: key differs. Are you sure (yes/no)? ')).toMatchObject({ kind: 'confirm' })
    expect(parsePrompt('Enter PIN for ED25519-SK key: ')).toMatchObject({ kind: 'text', hidden: true })
  })
})

describe('addresses', () => {
  it('turns an HTTPS remote into SSH only when that is certain', () => {
    expect(toSshUrl('https://github.com/a/b.git')).toBe('git@github.com:a/b.git')
    expect(toSshUrl('https://gitlab.com/group/sub/b')).toBe('git@gitlab.com:group/sub/b.git')
    expect(toSshUrl('git@github.com:a/b.git')).toBeNull()
    expect(toSshUrl('https://git.example.com:8443/a/b.git')).toBeNull()
    expect(toSshUrl('/srv/a.git')).toBeNull()
  })

  it('finds where to test a connection', () => {
    expect(targetFromUrl('git@github.com:a/b.git')).toEqual({ host: 'github.com', user: 'git' })
    expect(targetFromUrl('ssh://deploy@git.example.com:2222/a/b.git')).toEqual({ host: 'git.example.com', user: 'deploy', port: 2222 })
    expect(targetFromUrl('https://gitlab.com/a/b.git')).toEqual({ host: 'gitlab.com', user: 'git' })
    expect(targetFromUrl('/srv/a.git')).toBeNull()
  })

  it('opens the right page for adding a key', () => {
    expect(sshKeysPage('github', 'github.com')).toBe('https://github.com/settings/ssh/new')
    expect(sshKeysPage('gitlab', 'gitlab.com')).toBe('https://gitlab.com/-/user_settings/ssh_keys')
    expect(sshKeysPage('gitlab', 'git.corp.example')).toBe('https://git.corp.example/-/user_settings/ssh_keys')
  })
})

describe('finding the ssh that comes with Git on Windows', () => {
  it('walks up from the exec path, whatever folder is in between', () => {
    const root = tempDir()
    mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
    mkdirSync(join(root, 'ucrt64', 'libexec', 'git-core'), { recursive: true })
    writeFileSync(join(root, 'usr', 'bin', 'ssh.exe'), '')
    expect(gitUsrBin(join(root, 'ucrt64', 'libexec', 'git-core'))).toBe(join(root, 'usr', 'bin'))
  })

  it('reads every spelling of a Windows path as one', () => {
    expect(nativePath('C:/Users/me/.ssh/id', 'win32')).toBe('C:\\Users\\me\\.ssh\\id')
    expect(nativePath('/c/Users/me/.ssh/id', 'win32')).toBe('c:\\Users\\me\\.ssh\\id')
    expect(nativePath('/home/me/.ssh/id', 'linux')).toBe('/home/me/.ssh/id')
  })

  it('gives up where there is none', () => {
    expect(gitUsrBin(join(tempDir(), 'libexec', 'git-core'))).toBeNull()
  })
})

describe('reading the result of a key check', () => {
  it('finds the account in each server greeting', () => {
    const connected = (greeting: string): unknown => statusFromOutput(`debug1: Authenticated to host ([1.2.3.4]:22) using "publickey".\n${greeting}`)
    expect(connected("Hi betrayalove! You've successfully authenticated, but GitHub does not provide shell access.")).toEqual({ state: 'connected', account: 'betrayalove' })
    expect(connected('Welcome to GitLab, @mira!')).toEqual({ state: 'connected', account: 'mira' })
    expect(connected("Hi there, sam! You've successfully authenticated with the key named x")).toEqual({ state: 'connected', account: 'sam' })
    expect(connected('authenticated via ssh key.\nYou are logged in as kim.')).toEqual({ state: 'connected', account: 'kim' })
    expect(connected('PTY allocation request failed')).toEqual({ state: 'connected', account: null })
  })

  it('tells a locked key from a rejected one', () => {
    expect(statusFromOutput('debug1: Offering public key: /keys/id\ngit@h: Permission denied (publickey).')).toEqual({ state: 'rejected' })
    expect(statusFromOutput('debug1: Server accepts key: /keys/id ED25519 SHA256:x\ngit@h: Permission denied (publickey).')).toEqual({ state: 'locked' })
  })
})

describe('deciding who answers a question', () => {
  function setup(): { asked: AccessPrompt[]; saved: Map<string, string>; replies: (PromptReply | null)[]; time: { now: number }; broker: PromptBroker } {
    const asked: AccessPrompt[] = []
    const saved = new Map<string, string>()
    const replies: (PromptReply | null)[] = []
    const time = { now: 1000 }
    const store: SecretStore = {
      available: () => true,
      get: (key) => saved.get(key) ?? null,
      set: async (key, value) => void saved.set(key, value),
      delete: async (key) => void saved.delete(key)
    }
    const broker = new PromptBroker(async (prompt) => {
      asked.push(prompt)
      return replies.shift() ?? null
    }, store, async () => true, () => time.now)
    return { asked, saved, replies, time, broker }
  }
  const question = "Enter passphrase for key '/keys/id': "

  it('asks once per session and forgets after a while', async () => {
    const { asked, replies, time, broker, saved } = setup()
    replies.push({ answer: 'secret' })
    expect(await broker.handle({ prompt: question, background: false })).toBe('secret')
    expect(await broker.handle({ prompt: question, background: false })).toBe('secret')
    expect(asked).toHaveLength(1)
    expect(saved.size).toBe(0)
    time.now += 16 * 60_000
    replies.push({ answer: 'again' })
    expect(await broker.handle({ prompt: question, background: false })).toBe('again')
    expect(asked).toHaveLength(2)
  })

  it('saves only on request, and a wrong saved password is dropped', async () => {
    const { asked, replies, broker, saved } = setup()
    replies.push({ answer: 'old', remember: true })
    await broker.handle({ prompt: question, background: false })
    expect(saved.get('/keys/id')).toBe('old')
    broker.clearSession()
    expect(await broker.handle({ prompt: question, background: true })).toBe('old')
    replies.push({ answer: 'new' })
    expect(await broker.handle({ prompt: 'Bad passphrase, try again for /keys/id: ', background: false })).toBe('new')
    expect(saved.has('/keys/id')).toBe(false)
    expect(asked.at(-1)?.retry).toBe(true)
  })

  it('checks a password before giving it to ssh, and drops a saved one that stopped working', async () => {
    const asked: AccessPrompt[] = []
    const saved = new Map([['/keys/id', 'stale']])
    const replies = ['typo', 'right']
    const broker = new PromptBroker(async (prompt) => {
      asked.push(prompt)
      return { answer: replies.shift()! }
    }, {
      available: () => true,
      get: (key) => saved.get(key) ?? null,
      set: async (key, value) => void saved.set(key, value),
      delete: async (key) => void saved.delete(key)
    }, async (_path, value) => value === 'right')
    expect(await broker.handle({ prompt: question, background: true })).toBeNull()
    expect(saved.size).toBe(0)
    expect(await broker.handle({ prompt: question, background: false })).toBe('right')
    expect(asked.map((prompt) => prompt.retry)).toEqual([false, true])
  })

  it('never waits for a person in the background', async () => {
    const { asked, broker } = setup()
    expect(await broker.handle({ prompt: question, background: true })).toBeNull()
    expect(await broker.handle({ prompt: "The authenticity of host 'x' can't be established. (yes/no)", background: true })).toBeNull()
    expect(asked).toHaveLength(0)
  })

  it('treats the same key the same in both Windows path forms', () => {
    expect(normalizeKeyPath('/c/Users/Me/.ssh/id')).toBe(normalizeKeyPath('C:\\Users\\Me\\.ssh\\id'))
  })

  it('does not offer to remember HTTPS passwords, which git helpers keep', async () => {
    const { asked, replies, broker, saved } = setup()
    replies.push({ answer: 'pw', remember: true })
    await broker.handle({ prompt: "Password for 'https://me@host': ", background: false })
    expect(asked[0].canRemember).toBe(false)
    expect(saved.size).toBe(0)
  })
})
