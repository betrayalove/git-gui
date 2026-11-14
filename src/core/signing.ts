import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { GpgKey, SignatureInfo, SignatureState, SigningChoice, SigningState } from '../shared/types'
import { childEnv, git, runGit } from './git'
import { t } from '../shared/i18n'

const STATES: Record<string, SignatureState> = {
  G: 'good', U: 'untrusted', B: 'bad', X: 'expired', Y: 'expired', R: 'revoked', E: 'unknown-key', N: 'unverifiable'
}

/**
 * Whether a commit is signed, and what git makes of the signature. Presence is read from the
 * commit itself: without gpg.ssh.allowedSignersFile git reports an SSH signature as no signature.
 */
export async function readSignature(cwd: string, sha: string): Promise<SignatureInfo> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`${t('Недопустимая ссылка')}: ${sha}`)
  const raw = (await runGit(cwd, ['cat-file', 'commit', sha])).stdout.toString('latin1')
  const headers = raw.slice(0, raw.indexOf('\n\n'))
  const signature = /^gpgsig(?:-sha256)? (.*)$/m.exec(headers)?.[1] ?? ''
  if (!signature) return { state: 'none' }
  const format = signature.includes('SSH SIGNATURE') ? 'ssh' : signature.includes('SIGNED MESSAGE') ? 'x509' : 'openpgp'
  // Verification failures arrive as a status letter; anything on stderr is only git explaining it.
  const { stdout } = await runGit(cwd, ['log', '-1', '--format=%G?%x1f%GS%x1f%GK', sha, '--'], { okCodes: [1, 128] })
  const [letter, signer, key] = stdout.toString('utf8').trim().split('\x1f')
  return { state: STATES[letter] ?? 'unverifiable', format, signer: signer || undefined, key: key || undefined }
}

async function configValue(cwd: string, key: string, scope?: '--local' | '--global'): Promise<string> {
  const { stdout } = await runGit(cwd, ['config', ...(scope ? [scope] : []), '--get', key], { okCodes: [1] })
  return stdout.toString('utf8').trim()
}

/** How commits in this repository are signed, and whether that comes from this repository's own settings. */
export async function readSigning(cwd: string): Promise<SigningState> {
  const [enabled, format, key, localEnabled, localKey, globalEnabled, globalFormat, globalKey] = await Promise.all([
    configValue(cwd, 'commit.gpgsign'),
    configValue(cwd, 'gpg.format'),
    configValue(cwd, 'user.signingkey'),
    configValue(cwd, 'commit.gpgsign', '--local'),
    configValue(cwd, 'user.signingkey', '--local'),
    configValue(cwd, 'commit.gpgsign', '--global'),
    configValue(cwd, 'gpg.format', '--global'),
    configValue(cwd, 'user.signingkey', '--global')
  ])
  const choice: SigningState['choice'] = localEnabled === 'false' ? 'off'
    : localEnabled === 'true' && localKey ? (format === 'ssh' ? 'ssh' : 'openpgp')
      : 'inherit'
  return {
    choice,
    enabled: enabled === 'true' && Boolean(key),
    format: format || 'openpgp',
    key,
    inherited: { enabled: globalEnabled === 'true' && Boolean(globalKey), format: globalFormat || 'openpgp' }
  }
}

async function unset(cwd: string, key: string): Promise<void> {
  // Exit code 5 means the key was not set, which is the wanted result anyway.
  await runGit(cwd, ['config', '--local', '--unset-all', key], { okCodes: [5] })
}

/**
 * Sets signing for this repository only. Global settings are never touched: "inherit" removes
 * the repository's own lines, so whatever the person set up globally applies again.
 */
export async function setSigning(cwd: string, choice: SigningChoice): Promise<void> {
  if (choice.mode === 'inherit') {
    for (const key of ['commit.gpgsign', 'tag.gpgsign', 'gpg.format', 'user.signingkey']) await unset(cwd, key)
    return
  }
  if (choice.mode === 'off') {
    await git(cwd, ['config', '--local', 'commit.gpgsign', 'false'])
    return
  }
  const key = choice.key.trim()
  if (choice.mode === 'ssh') {
    // A key that lives only in the agent is given as its public line, which git accepts with this prefix.
    const valid = key.startsWith('key::ssh-') || (key.endsWith('.pub') && existsSync(key))
    if (!valid) throw new Error(t('Не нашёл открытую часть ключа: {value}', { value: key }))
  } else if (choice.mode === 'openpgp') {
    if (!/^[0-9A-Fa-f]{8,40}$/.test(key)) throw new Error(t('Недопустимый идентификатор ключа GPG: {value}', { value: key }))
  } else {
    throw new Error(t('Неизвестный способ подписи'))
  }
  await git(cwd, ['config', '--local', 'gpg.format', choice.mode])
  await git(cwd, ['config', '--local', 'user.signingkey', key])
  await git(cwd, ['config', '--local', 'commit.gpgsign', 'true'])
}

/** Secret keys from `gpg --list-secret-keys --with-colons`, each with its first user ID. */
export function parseGpgKeys(output: string): GpgKey[] {
  const keys: GpgKey[] = []
  for (const line of output.split('\n')) {
    const fields = line.split(':')
    // Field 2 holds validity: e expired, r revoked, d disabled. Such keys cannot sign.
    if (fields[0] === 'sec' && !/[erd]/.test(fields[1])) keys.push({ id: fields[4], uid: '' })
    else if (fields[0] === 'uid' && keys.length && !keys[keys.length - 1].uid) keys[keys.length - 1].uid = fields[9].replace(/\\x3a/g, ':')
  }
  return keys
}

/** The GPG keys that can sign; empty when GPG is not installed. Uses the program git would use. */
export async function listGpgKeys(cwd: string): Promise<GpgKey[]> {
  const program = (await configValue(cwd, 'gpg.program')) || 'gpg'
  return new Promise((resolve) => {
    const child = spawn(program, ['--list-secret-keys', '--with-colons'], { windowsHide: true, env: childEnv() })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8') })
    child.on('error', () => resolve([]))
    child.on('close', (code) => resolve(code === 0 ? parseGpgKeys(out) : []))
  })
}
