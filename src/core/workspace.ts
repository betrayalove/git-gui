import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LfsInfo, Submodule, Worktree } from '../shared/types'
import { git, gitLine, runGit } from './git'

/** All checkouts of this repository. The first is the main one. */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const current = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  const raw = await git(cwd, ['worktree', 'list', '--porcelain'])
  return raw.split('\n\n').filter((block) => block.trim()).map((block, index) => {
    const value = (key: string): string | undefined => new RegExp(`^${key}(?: (.*))?$`, 'm').exec(block)?.[1] ?? (new RegExp(`^${key}$`, 'm').test(block) ? '' : undefined)
    const path = value('worktree') ?? ''
    return {
      path,
      head: value('HEAD') ?? null,
      branch: value('branch')?.replace(/^refs\/heads\//, '') ?? null,
      main: index === 0,
      current: samePath(path, current),
      locked: value('locked') !== undefined,
      prunable: value('prunable') !== undefined,
      bare: value('bare') !== undefined
    }
  })
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string): string => path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return normal(a) === normal(b)
}

/** Checks out a branch in a new folder. With `newBranch` the branch is created from `from`. */
export async function addWorktree(cwd: string, options: { path: string; branch: string; newBranch?: boolean; from?: string }): Promise<void> {
  const { code } = await runGit(cwd, ['check-ref-format', '--branch', options.branch], { okCodes: [128] })
  if (code !== 0 || options.branch.startsWith('-')) throw new Error(`Недопустимое имя ветки: ${options.branch}`)
  const args = options.newBranch
    ? ['worktree', 'add', '-b', options.branch, '--', options.path, options.from ?? 'HEAD']
    : ['worktree', 'add', '--', options.path, options.branch]
  await git(cwd, args)
}

/** Removes a checkout and its folder. Without `force`, git refuses when it has uncommitted work. */
export async function removeWorktree(cwd: string, path: string, force = false): Promise<void> {
  await git(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path])
}

export async function pruneWorktrees(cwd: string): Promise<void> {
  await git(cwd, ['worktree', 'prune'])
}

const SUBMODULE_STATE: Record<string, Submodule['state']> = { ' ': 'ok', '-': 'missing', '+': 'changed', U: 'conflict' }

/** Submodules at every level, with the address each one comes from. */
export async function listSubmodules(cwd: string): Promise<Submodule[]> {
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  const modules = await readFile(join(root, '.gitmodules'), 'utf8').catch(() => null)
  if (modules === null) return []
  const urls = new Map<string, string>()
  const { stdout } = await runGit(root, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { okCodes: [1] })
  const byName = new Map<string, { path?: string; url?: string }>()
  for (const line of stdout.toString('utf8').split('\n')) {
    const match = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line)
    if (!match) continue
    const entry = byName.get(match[1]) ?? {}
    entry[match[2] as 'path' | 'url'] = match[3]
    byName.set(match[1], entry)
  }
  for (const entry of byName.values()) if (entry.path && entry.url) urls.set(entry.path, entry.url)
  const raw = await git(root, ['submodule', 'status', '--recursive'])
  return raw.split('\n').filter(Boolean).map((line) => {
    // The path may hold spaces. Git adds the description in brackets only for a downloaded submodule.
    const match = /^(.)([0-9a-f]+) (.+?)(?: \((.*)\))?$/.exec(line)
    if (!match) throw new Error(`Не удалось разобрать состояние submodule: ${line}`)
    return { path: match[3], sha: match[2], state: SUBMODULE_STATE[match[1]] ?? 'ok', url: urls.get(match[3]) ?? null, describe: match[4] ?? null }
  })
}

/** Downloads submodules and checks out the commits the repository records. */
export async function updateSubmodules(cwd: string, paths: string[] = []): Promise<void> {
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  await git(root, ['submodule', 'update', '--init', '--recursive', '--', ...paths])
}

// LFS patterns are globs, and git-lfs passes them on to the git commands it runs itself.
const LFS_OPTIONS = { env: { GIT_LITERAL_PATHSPECS: '0' } }

/** Whether Git LFS is installed and what this repository stores with it. */
export async function lfsInfo(cwd: string): Promise<LfsInfo> {
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  const attributes = await readFile(join(root, '.gitattributes'), 'utf8').catch(() => '')
  const patterns = attributes.split('\n')
    .filter((line) => /\bfilter=lfs\b/.test(line) && !line.trim().startsWith('#'))
    .map((line) => line.trim().split(/\s+/)[0])
  const installed = (await runGit(root, ['lfs', 'version'], { okCodes: [1, 128] }).catch(() => ({ code: -1 }))).code === 0
  if (!installed) return { installed, used: patterns.length > 0, patterns, files: [] }
  const raw = await git(root, ['lfs', 'ls-files'], LFS_OPTIONS)
  // Each line is "<oid> <* or -> <path>": a star means the content is here, a dash only the pointer.
  const files = raw.split('\n').map((line) => /^\S+ ([*-]) (.+)$/.exec(line)).filter((match) => match !== null)
    .map((match) => ({ path: match[2], downloaded: match[1] === '*' }))
  return { installed, used: patterns.length > 0 || files.length > 0, patterns, files }
}

export async function lfsPull(cwd: string): Promise<void> {
  await git(cwd, ['lfs', 'pull'], LFS_OPTIONS)
}

/** Stores files matching `pattern` in LFS from now on. Existing history is not changed. */
export async function lfsTrack(cwd: string, pattern: string): Promise<void> {
  if (!pattern.trim() || pattern.startsWith('-')) throw new Error(`Недопустимая маска: ${pattern}`)
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  await git(root, ['lfs', 'track', '--', pattern.trim()], LFS_OPTIONS)
}
