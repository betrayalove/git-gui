import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll } from 'vitest'
import { git, gitLine } from '../src/core/git'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

export function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-test-'))
  roots.push(root)
  return root
}

let clock = 1_700_000_000

export function resetClock(): void {
  clock = 1_700_000_000
}

function identityEnv(): Record<string, string> {
  const date = `${clock++} +0300`
  return {
    GIT_AUTHOR_NAME: 'Ann Author',
    GIT_AUTHOR_EMAIL: 'ann@example.com',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'Carl Committer',
    GIT_COMMITTER_EMAIL: 'carl@example.com',
    GIT_COMMITTER_DATE: date
  }
}

export async function createRepo(): Promise<string> {
  const dir = tempDir()
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'Test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

export function write(dir: string, path: string, content: string): void {
  const full = join(dir, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

export async function commitFile(dir: string, path: string, content: string, message: string): Promise<string> {
  write(dir, path, content)
  await git(dir, ['add', '--all'])
  await git(dir, ['commit', '-m', message], { env: identityEnv() })
  return gitLine(dir, ['rev-parse', 'HEAD'])
}

export async function mergeNoFf(dir: string, branch: string, message: string): Promise<string> {
  await git(dir, ['merge', '--no-ff', '-m', message, branch], { env: identityEnv() })
  return gitLine(dir, ['rev-parse', 'HEAD'])
}

/** Creates a bare server and a clone of `dir` wired to it as origin. */
export async function addOrigin(dir: string): Promise<string> {
  const bare = tempDir()
  await git(bare, ['init', '--bare', '-b', 'main'])
  await git(dir, ['remote', 'add', 'origin', bare])
  await git(dir, ['push', '--set-upstream', 'origin', 'main'])
  await git(dir, ['remote', 'set-head', 'origin', 'main'])
  return bare
}

export async function log(dir: string, rev = 'HEAD', format = '%s'): Promise<string[]> {
  return (await git(dir, ['log', `--format=${format}`, rev])).split('\n').filter(Boolean)
}

export async function head(dir: string, rev = 'HEAD'): Promise<string> {
  return gitLine(dir, ['rev-parse', rev])
}
