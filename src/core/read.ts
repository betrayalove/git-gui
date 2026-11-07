import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  BlameCommit,
  BlameResult,
  BlobContent,
  Commit,
  DiffHunk,
  DiffLine,
  DiffResult,
  FileDiff,
  FileState,
  FileVersion,
  OperationInProgress,
  RefInfo,
  RemoteInfo,
  RepoStatus,
  StashEntry,
  StatusFile
} from '../shared/types'
import { git, gitLine, runGit } from './git'

const FS = '\x1f'
const RS = '\x1e'
const LOG_FORMAT = [
  '%H', '%P', '%T', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%B'
].join('%x1f')

function parseLog(raw: string): Commit[] {
  return raw
    .split(RS)
    .slice(1)
    .map((record) => {
      const fields = record.split(FS)
      const message = fields.slice(9).join(FS).replace(/\n+$/, '')
      return {
        sha: fields[0].trim(),
        parents: fields[1] ? fields[1].split(' ') : [],
        tree: fields[2],
        authorName: fields[3],
        authorEmail: fields[4],
        authorDate: fields[5],
        committerName: fields[6],
        committerEmail: fields[7],
        committerDate: fields[8],
        subject: message.split('\n')[0],
        message
      }
    })
}

export interface LogOptions {
  limit?: number
  skip?: number
  revs?: string[]
  path?: string
}

export async function readLog(cwd: string, options: LogOptions = {}): Promise<Commit[]> {
  const unborn = !(await hasCommits(cwd))
  if (unborn) return []
  const args = ['log', `--format=${RS}${LOG_FORMAT}`, '--topo-order']
  args.push(`--max-count=${options.limit ?? 5000}`)
  if (options.skip) args.push(`--skip=${options.skip}`)
  if (options.revs?.length) args.push(...options.revs)
  else args.push('--branches', '--tags', '--remotes', 'HEAD')
  args.push('--')
  if (options.path) args.push(options.path)
  return parseLog(await git(cwd, args))
}

const SEARCH_LIMIT = 1000

/** Escapes text for the extended regular expressions git uses in -G. */
function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Commits whose changes add or remove a line containing `text`, in any branch or tag. Case is
 * ignored. The result holds SHAs only: the history list already has the commits.
 */
export async function searchChanges(cwd: string, options: { text: string; path?: string; limit?: number }): Promise<{ shas: string[]; limited: boolean }> {
  const text = options.text.trim()
  if (!text || !(await hasCommits(cwd))) return { shas: [], limited: false }
  const limit = options.limit ?? SEARCH_LIMIT
  const raw = await git(cwd, [
    'log', '--format=%H', '--branches', '--tags', '--remotes', 'HEAD',
    `-G${literalPattern(text)}`, '--regexp-ignore-case', `--max-count=${limit + 1}`,
    '--', ...(options.path ? [options.path] : [])
  ])
  const shas = raw.split('\n').filter(Boolean)
  return { shas: shas.slice(0, limit), limited: shas.length > limit }
}

/** Paths of all files in a commit, for picking one. */
export async function listFiles(cwd: string, rev = 'HEAD'): Promise<string[]> {
  if (!(await hasCommits(cwd))) return []
  const raw = await git(cwd, ['ls-tree', '-r', '--name-only', '-z', rev])
  return raw.split('\0').filter(Boolean)
}

const STATUS_LETTER: Record<string, FileState> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange'
}

/** Every commit that changed a file, following it through renames. Newest first. */
export async function fileHistory(cwd: string, path: string, limit = 1000): Promise<FileVersion[]> {
  if (!(await hasCommits(cwd))) return []
  const raw = await git(cwd, [
    'log', '--follow', '-M', `--max-count=${limit}`, `--format=${RS}${LOG_FORMAT}${RS}`, '--name-status', '-z', 'HEAD', '--', path
  ])
  // Each record is the commit, then its name-status entries, separated by the same marker.
  const parts = raw.split(RS).slice(1)
  const versions: FileVersion[] = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const [commit] = parseLog(RS + parts[index])
    const fields = parts[index + 1].split('\0').map((field) => field.replace(/^\n+/, '')).filter(Boolean)
    const letter = fields[0]?.[0] ?? 'M'
    const current = letter === 'R' || letter === 'C' ? fields[2] : fields[1]
    versions.push({ commit, path: current ?? path, status: STATUS_LETTER[letter] ?? 'modified' })
  }
  return versions
}

const BLAME_MAX_BYTES = 4 * 1024 * 1024

/** Who last changed each line of a file in `rev`. */
export async function blameFile(cwd: string, path: string, rev = 'HEAD'): Promise<BlameResult> {
  const object = `${rev}:${path}`
  const size = Number(await gitLine(cwd, ['cat-file', '-s', object]))
  if (size > BLAME_MAX_BYTES) return { lines: [], commits: {}, skipped: 'too-large' }
  const sample = (await runGit(cwd, ['cat-file', 'blob', object])).stdout.subarray(0, 8000)
  if (sample.includes(0)) return { lines: [], commits: {}, skipped: 'binary' }
  const raw = await git(cwd, ['blame', '--porcelain', rev, '--', path])
  const result: BlameResult = { lines: [], commits: {} }
  let current: BlameCommit | null = null
  let lineNumber = 0
  const times = new Map<string, { time: number; zone: string }>()
  for (const line of raw.split('\n')) {
    if (line.startsWith('\t')) {
      result.lines.push({ sha: current!.sha, line: lineNumber, text: line.slice(1) })
      continue
    }
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line)
    if (header) {
      lineNumber = Number(header[2])
      current = result.commits[header[1]] ??= { sha: header[1], authorName: '', authorEmail: '', authorDate: '', summary: '' }
      continue
    }
    if (!current) continue
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'author') current.authorName = value
    else if (key === 'author-mail') current.authorEmail = value.replace(/^<|>$/g, '')
    else if (key === 'summary') current.summary = value
    else if (key === 'author-time') times.set(current.sha, { ...times.get(current.sha) ?? { zone: '+0000' }, time: Number(value) })
    else if (key === 'author-tz') times.set(current.sha, { ...times.get(current.sha) ?? { time: 0 }, zone: value })
  }
  for (const [sha, { time }] of times) result.commits[sha].authorDate = new Date(time * 1000).toISOString()
  return result
}

export async function readCommits(cwd: string, revs: string[]): Promise<Commit[]> {
  const args = ['log', `--format=${RS}${LOG_FORMAT}`, '--topo-order', ...revs, '--']
  return parseLog(await git(cwd, args))
}

async function hasCommits(cwd: string): Promise<boolean> {
  const { stdout } = await runGit(cwd, ['for-each-ref', '--count=1', 'refs/heads', 'refs/tags', 'refs/remotes'])
  if (stdout.length > 0) return true
  const { code } = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] })
  return code === 0
}

export async function isRepository(path: string): Promise<boolean> {
  try {
    const { code } = await runGit(path, ['rev-parse', '--git-dir'], { okCodes: [128] })
    return code === 0
  } catch {
    return false
  }
}

export async function repoRoot(path: string): Promise<string> {
  return gitLine(path, ['rev-parse', '--show-toplevel'])
}

export async function commonDir(cwd: string): Promise<string> {
  return resolve(cwd, await gitLine(cwd, ['rev-parse', '--git-common-dir']))
}

export async function readRefs(cwd: string): Promise<RefInfo[]> {
  const format = [
    '%(refname)', '%(objectname)', '%(*objectname)', '%(upstream)', '%(upstream:track,nobracket)',
    '%(HEAD)', '%(committerdate:iso-strict)', '%(symref)'
  ].join('%00')
  const raw = await git(cwd, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes', 'refs/tags'])
  const refs: RefInfo[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [ref, sha, peeled, upstream, track, head, date, symref] = line.split('\0')
    if (symref) continue
    const kind = ref.startsWith('refs/heads/') ? 'branch' : ref.startsWith('refs/tags/') ? 'tag' : 'remote'
    const name = ref.replace(/^refs\/(heads|tags|remotes)\//, '')
    const info: RefInfo = { ref, name, kind, sha, target: peeled || sha, date: date || undefined }
    if (kind === 'branch') {
      info.isHead = head === '*'
      if (upstream) {
        info.upstream = upstream.replace(/^refs\/remotes\//, '')
        info.upstreamGone = track === 'gone'
        info.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
        info.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
      }
    }
    refs.push(info)
  }
  return refs
}

export async function readRemotes(cwd: string): Promise<RemoteInfo[]> {
  const raw = await git(cwd, ['remote', '-v'])
  const byName = new Map<string, RemoteInfo>()
  for (const line of raw.split('\n')) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line)
    if (!match) continue
    const entry = byName.get(match[1]) ?? { name: match[1], fetchUrl: '', pushUrl: '' }
    if (match[3] === 'fetch') entry.fetchUrl = match[2]
    else entry.pushUrl = match[2]
    byName.set(match[1], entry)
  }
  for (const entry of byName.values()) {
    const { stdout, code } = await runGit(
      cwd,
      ['symbolic-ref', '--quiet', '--short', `refs/remotes/${entry.name}/HEAD`],
      { okCodes: [1] }
    )
    if (code === 0) entry.defaultBranch = stdout.toString('utf8').trim().replace(`${entry.name}/`, '')
  }
  return [...byName.values()]
}

function stateFromCode(code: string): FileState | undefined {
  switch (code) {
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    case 'C': return 'copied'
    case 'T': return 'typechange'
    default: return undefined
  }
}

function parseStatus(raw: string): Omit<RepoStatus, 'operation'> {
  const status: Omit<RepoStatus, 'operation'> = {
    head: null, headSha: null, detached: false, ahead: 0, behind: 0, files: []
  }
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice(13)
      status.headSha = oid === '(initial)' ? null : oid
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14)
      status.detached = head === '(detached)'
      status.head = status.detached ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice(18)
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (line.startsWith('1 ')) {
      const fields = line.split(' ')
      const file: StatusFile = {
        path: fields.slice(8).join(' '),
        staged: stateFromCode(fields[1][0]),
        unstaged: stateFromCode(fields[1][1])
      }
      status.files.push(file)
    } else if (line.startsWith('2 ')) {
      const fields = line.split(' ')
      status.files.push({
        path: fields.slice(9).join(' '),
        origPath: parts[++i],
        staged: stateFromCode(fields[1][0]),
        unstaged: stateFromCode(fields[1][1])
      })
    } else if (line.startsWith('u ')) {
      const fields = line.split(' ')
      status.files.push({ path: fields.slice(10).join(' '), unstaged: 'conflicted' })
    } else if (line.startsWith('? ')) {
      status.files.push({ path: line.slice(2), unstaged: 'untracked' })
    }
  }
  return status
}

export async function readOperation(cwd: string): Promise<OperationInProgress | undefined> {
  const gitDir = resolve(cwd, await gitLine(cwd, ['rev-parse', '--git-dir']))
  const has = (name: string): boolean => existsSync(join(gitDir, name))
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  if (has('BISECT_LOG')) return 'bisect'
  return undefined
}

export async function readStatus(cwd: string): Promise<RepoStatus> {
  const raw = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], {
    env: { GIT_OPTIONAL_LOCKS: '0' }
  })
  return { ...parseStatus(raw), operation: await readOperation(cwd) }
}

export async function readStashes(cwd: string): Promise<StashEntry[]> {
  const { stdout, code } = await runGit(
    cwd,
    ['stash', 'list', '--format=%gd%x00%H%x00%gs%x00%cI', '--date=default'],
    { okCodes: [1] }
  )
  if (code !== 0) return []
  const entries: StashEntry[] = []
  for (const line of stdout.toString('utf8').split('\n')) {
    if (!line) continue
    const [selector, sha, subject, date] = line.split('\0')
    const index = Number(/\{(\d+)\}/.exec(selector)?.[1] ?? entries.length)
    const branch = /^(?:WIP on|On) ([^:]+):/.exec(subject)?.[1]
    entries.push({
      ref: `stash@{${index}}`,
      index,
      sha,
      date,
      branch,
      message: subject.replace(/^WIP on [^:]+: /, 'WIP: ').replace(/^On [^:]+: /, '')
    })
  }
  return entries
}

const DIFF_LIMIT = 4 * 1024 * 1024

export function parseDiff(raw: string): DiffResult {
  const truncated = raw.length >= DIFF_LIMIT
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  const unquote = (path: string): string => {
    if (!path.startsWith('"')) return path
    const bytes: number[] = []
    const inner = path.slice(1, -1)
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\') {
        const next = inner[++i]
        if (/[0-7]/.test(next)) {
          bytes.push(parseInt(inner.slice(i, i + 3), 8))
          i += 2
        } else {
          bytes.push(({ n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 } as Record<string, number>)[next] ?? next.charCodeAt(0))
        }
      } else {
        bytes.push(...Buffer.from(inner[i], 'utf8'))
      }
    }
    return Buffer.from(bytes).toString('utf8')
  }
  const stripPrefix = (path: string): string => unquote(path).replace(/^[ab]\//, '')
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (?:"?a\/.*"? )?("?b\/.*"?)$/.exec(line)
      file = {
        path: match ? stripPrefix(match[1]) : line.slice(11),
        status: 'modified', binary: false, additions: 0, deletions: 0, header: [line], hunks: []
      }
      files.push(file)
      hunk = null
    } else if (!file) {
      continue
    } else if (!hunk || !/^[ +\-\\]/.test(line)) {
      if (!line.startsWith('@@') && !hunk && line) file.header.push(line)
      if (line.startsWith('new file')) file.status = 'added'
      else if (line.startsWith('deleted file')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquote(line.slice(12)) }
      else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
      else if (line.startsWith('copy from ')) { file.status = 'copied'; file.oldPath = unquote(line.slice(10)) }
      else if (line.startsWith('copy to ')) file.path = unquote(line.slice(8))
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4).replace(/\t$/, ''))
      else if (line.startsWith('--- ') && line !== '--- /dev/null' && file.status === 'modified') {
        const old = stripPrefix(line.slice(4).replace(/\t$/, ''))
        file.path = old
      } else if (line.startsWith('@@')) {
        const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
        oldNo = Number(match?.[1] ?? 0)
        newNo = Number(match?.[2] ?? 0)
        hunk = { header: line, lines: [] }
        file.hunks.push(hunk)
      }
    } else {
      const entry: DiffLine = { type: 'context', text: line.slice(1) }
      if (line[0] === '+') {
        entry.type = 'add'
        entry.newNo = newNo++
        file.additions++
      } else if (line[0] === '-') {
        entry.type = 'del'
        entry.oldNo = oldNo++
        file.deletions++
      } else if (line[0] === '\\') {
        entry.type = 'note'
      } else {
        entry.oldNo = oldNo++
        entry.newNo = newNo++
      }
      hunk.lines.push(entry)
    }
  }
  return { files, truncated }
}

async function diffOutput(cwd: string, args: string[], okCodes: number[] = []): Promise<DiffResult> {
  const { stdout } = await runGit(cwd, args, { okCodes })
  const raw = stdout.length > DIFF_LIMIT ? stdout.subarray(0, DIFF_LIMIT).toString('utf8') : stdout.toString('utf8')
  return parseDiff(raw)
}

const BLOB_LIMIT = 2 * 1024 * 1024

export async function readBlob(cwd: string, oid: string): Promise<BlobContent> {
  const { stdout } = await runGit(cwd, ['cat-file', 'blob', oid])
  return {
    text: stdout.length > BLOB_LIMIT || stdout.includes(0) ? '' : stdout.toString('utf8'),
    binary: stdout.includes(0),
    tooLarge: stdout.length > BLOB_LIMIT
  }
}

export function commitDiff(cwd: string, sha: string): Promise<DiffResult> {
  return diffOutput(cwd, ['show', '--format=', '--no-color', '--patch', '-M', '--first-parent', sha, '--'])
}

export function stashDiff(cwd: string, sha: string): Promise<DiffResult> {
  return diffOutput(cwd, ['stash', 'show', '--no-color', '--patch', '--include-untracked', sha])
}

export function worktreeDiff(cwd: string, path: string, staged: boolean, untracked: boolean): Promise<DiffResult> {
  if (untracked) {
    return diffOutput(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path], [1])
  }
  return diffOutput(cwd, ['diff', '--no-color', '-M', ...(staged ? ['--cached'] : []), '--', path])
}
