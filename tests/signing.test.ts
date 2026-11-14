import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { commit } from '../src/core/ops'
import { listGpgKeys, parseGpgKeys, readSignature, readSigning, setSigning } from '../src/core/signing'
import { createRepo, tempDir, write } from './helpers'
import { sshTool } from './ssh-server'

const previous = { ...process.env }
let globalConfig = ''

beforeAll(() => {
  // Signing settings of whoever runs the tests must not leak in, and nothing may be written to them.
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  globalConfig = join(tempDir(), 'gitconfig')
  writeFileSync(globalConfig, '')
  process.env.GIT_CONFIG_GLOBAL = globalConfig
})

afterAll(() => {
  for (const key of ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GNUPGHOME']) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

/** A repository without the helper's own signing setting, so the one under test decides. */
async function repo(): Promise<string> {
  const dir = await createRepo()
  await git(dir, ['config', '--local', '--unset', 'commit.gpgsign'], { okCodes: [5] })
  return dir
}

function sshKey(): string {
  const path = join(tempDir(), 'signing_key')
  execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'mira@laptop', '-f', path])
  return path
}

describe('signing settings', () => {
  it('signs new commits with an SSH key for this repository only', async () => {
    const dir = await repo()
    const key = sshKey()
    expect(await readSigning(dir)).toMatchObject({ choice: 'inherit', enabled: false })
    await setSigning(dir, { mode: 'ssh', key: `${key}.pub` })
    expect(await readSigning(dir)).toMatchObject({ choice: 'ssh', enabled: true, format: 'ssh', key: `${key}.pub`, inherited: { enabled: false } })
    write(dir, 'a.txt', '1\n')
    await git(dir, ['add', '--all'])
    const sha = await commit(dir, { message: 'Signed' })
    expect(await readSignature(dir, sha)).toEqual({ state: 'unverifiable', format: 'ssh', signer: undefined, key: undefined })
    expect(readFileSync(globalConfig, 'utf8')).not.toContain('signingkey')
  })

  it('verifies an SSH signature once the signer is allowed', async () => {
    const dir = await repo()
    const key = sshKey()
    await setSigning(dir, { mode: 'ssh', key: `${key}.pub` })
    const allowed = join(tempDir(), 'allowed_signers')
    writeFileSync(allowed, `test@example.com ${readFileSync(`${key}.pub`, 'utf8')}`)
    await git(dir, ['config', 'gpg.ssh.allowedSignersFile', allowed])
    const sha = await commit(dir, { message: 'Signed', allowEmpty: true })
    expect(await readSignature(dir, sha)).toMatchObject({ state: 'good', format: 'ssh', signer: 'test@example.com' })
  })

  it('reports a commit without a signature', async () => {
    const dir = await repo()
    const sha = await commit(dir, { message: 'Plain', allowEmpty: true })
    expect(await readSignature(dir, sha)).toEqual({ state: 'none' })
  })

  it('turns signing off here, and back to the global setting', async () => {
    const dir = await repo()
    const key = sshKey()
    writeFileSync(globalConfig, `${readFileSync(globalConfig, 'utf8')}[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = ${key.replaceAll('\\', '/')}.pub\n`)
    try {
      expect(await readSigning(dir)).toMatchObject({ choice: 'inherit', enabled: true, format: 'ssh' })
      await setSigning(dir, { mode: 'off' })
      expect(await readSigning(dir)).toMatchObject({ choice: 'off', enabled: false, inherited: { enabled: true, format: 'ssh' } })
      const sha = await commit(dir, { message: 'Unsigned here', allowEmpty: true })
      expect(await readSignature(dir, sha)).toEqual({ state: 'none' })
      await setSigning(dir, { mode: 'inherit' })
      expect(await readSigning(dir)).toMatchObject({ choice: 'inherit', enabled: true })
      expect(await gitLine(dir, ['config', '--local', '--list'])).not.toContain('gpgsign')
    } finally {
      writeFileSync(globalConfig, readFileSync(globalConfig, 'utf8').replace(/\[commit\][\s\S]*$/, ''))
    }
  })

  it('refuses a key that is not a public key file or a GPG key ID', async () => {
    const dir = await repo()
    await expect(setSigning(dir, { mode: 'ssh', key: '/no/such/key.pub' })).rejects.toThrow()
    await expect(setSigning(dir, { mode: 'ssh', key: sshKey() })).rejects.toThrow()
    await expect(setSigning(dir, { mode: 'openpgp', key: '--global' })).rejects.toThrow()
    expect(await readSigning(dir)).toMatchObject({ choice: 'inherit' })
  })
})

describe('GPG keys', () => {
  it('reads secret keys and their first user ID, leaving out expired and revoked ones', () => {
    const output = [
      'sec:u:255:22:AAAABBBBCCCCDDDD:1700000000:::u:::scESC:::+:::23::0:',
      'fpr:::::::::0123456789ABCDEF0123AAAABBBBCCCCDDDD:',
      'uid:u::::1700000000::HASH::Mira Example <mira@example.com>::::::::::0:',
      'uid:u::::1700000000::HASH::Mira Work\\x3a Team <mira@work.example>::::::::::0:',
      'sec:e:255:22:1111222233334444:1600000000:1650000000::u:::scESC:::+:::23::0:',
      'uid:e::::1600000000::HASH::Old Key <old@example.com>::::::::::0:'
    ].join('\n')
    expect(parseGpgKeys(output)).toEqual([{ id: 'AAAABBBBCCCCDDDD', uid: 'Mira Example <mira@example.com>' }])
  })

  const hasGpg = (() => {
    try {
      execFileSync('gpg', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  it.runIf(process.env.CHRONICLE_REQUIRE_GPG)('has GPG to test against', () => {
    expect(hasGpg).toBe(true)
  })

  it.runIf(hasGpg)('signs with a GPG key and verifies it', async () => {
    process.env.GNUPGHOME = tempDir()
    execFileSync('gpg', ['--batch', '--passphrase', '', '--quick-gen-key', 'Test <test@example.com>', 'ed25519', 'sign', 'never'], { stdio: 'ignore' })
    const dir = await repo()
    const [key] = await listGpgKeys(dir)
    expect(key.uid).toBe('Test <test@example.com>')
    await setSigning(dir, { mode: 'openpgp', key: key.id })
    const sha = await commit(dir, { message: 'Signed with GPG', allowEmpty: true })
    expect(await readSignature(dir, sha)).toMatchObject({ state: 'good', format: 'openpgp', signer: 'Test <test@example.com>' })
  }, 60000)
})
