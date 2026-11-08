import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CommitEdit,
  ConflictFile,
  ConflictResolution,
  JournalEntry,
  RebaseRange,
  RefUpdate,
  RewriteConflict,
  RewritePlan,
  RewritePreview,
  SigningSetup,
  TodoItem
} from '../shared/types'
import { git, GitError, gitLine, isAncestor, revParse, runGit, spawnGit } from './git'
import { commonDir, readCommits, readOperation, readRefs, readStatus } from './read'


interface RawCommit {
  sha: string
  tree: string
  parents: string[]
  /** Everything is kept as latin1 so that the original bytes survive a round trip. */
  author: string
  committer: string
  encoding?: string
  extraHeaders: string[]
  signed: boolean
  message: string
}

function parseRawCommit(sha: string, data: Buffer): RawCommit {
  const text = data.toString('latin1')
  const split = text.indexOf('\n\n')
  const headerText = split === -1 ? text : text.slice(0, split)
  const message = split === -1 ? '' : text.slice(split + 2)
  const commit: RawCommit = {
    sha, tree: '', parents: [], author: '', committer: '', extraHeaders: [], signed: false, message
  }
  const headers: string[] = []
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ') && headers.length) headers[headers.length - 1] += `\n${line}`
    else headers.push(line)
  }
  for (const header of headers) {
    const space = header.indexOf(' ')
    const key = header.slice(0, space)
    const value = header.slice(space + 1)
    if (key === 'tree') commit.tree = value
    else if (key === 'parent') commit.parents.push(value)
    else if (key === 'author') commit.author = value
    else if (key === 'committer') commit.committer = value
    else if (key === 'encoding') commit.encoding = value
    else if (key === 'gpgsig' || key === 'gpgsig-sha256') commit.signed = true
    else commit.extraHeaders.push(header)
  }
  return commit
}

function serializeCommit(commit: Omit<RawCommit, 'sha' | 'signed'>): Buffer {
  const lines = [`tree ${commit.tree}`]
  for (const parent of commit.parents) lines.push(`parent ${parent}`)
  lines.push(`author ${commit.author}`, `committer ${commit.committer}`)
  if (commit.encoding) lines.push(`encoding ${commit.encoding}`)
  lines.push(...commit.extraHeaders)
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'latin1')
}

function utf8ToLatin1(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1')
}

function assertIdentityField(value: string, label: string): void {
  if (/[<>\n\0]/.test(value)) throw new Error(`${label} содержит недопустимые символы: ${value}`)
}

function formatGitDate(iso: string): string {
  const millis = Date.parse(iso)
  if (Number.isNaN(millis)) throw new Error(`Некорректная дата: ${iso}`)
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(iso)
  const zone = offset ? `${offset[1]}${offset[2]}${offset[3]}` : '+0000'
  return `${Math.floor(millis / 1000)} ${zone}`
}

function editIdentity(line: string, name?: string, email?: string, date?: string): string {
  const match = /^(.*) <(.*)> (\d+ [+-]\d{4})$/s.exec(line)
  if (!match) throw new Error(`Не удалось разобрать строку автора: ${line}`)
  if (name !== undefined) assertIdentityField(name, 'Имя')
  if (email !== undefined) assertIdentityField(email, 'Email')
  const newName = name !== undefined ? utf8ToLatin1(name) : match[1]
  const newEmail = email !== undefined ? utf8ToLatin1(email) : match[2]
  const newDate = date !== undefined ? formatGitDate(date) : match[3]
  return `${newName} <${newEmail}> ${newDate}`
}

/** Transcodes a commit with a legacy encoding to UTF-8 before mixing in UTF-8 edits. */
function normalizeEncoding(commit: RawCommit): void {
  if (!commit.encoding || /^utf-?8$/i.test(commit.encoding)) return
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(commit.encoding)
  } catch {
    return
  }
  const convert = (text: string): string => utf8ToLatin1(decoder.decode(Buffer.from(text, 'latin1')))
  commit.author = convert(commit.author)
  commit.committer = convert(commit.committer)
  commit.message = convert(commit.message)
  commit.encoding = undefined
}

function applyEdit(commit: RawCommit, edit: CommitEdit | undefined): void {
  if (!edit) return
  normalizeEncoding(commit)
  if (edit.message !== undefined) {
    const message = edit.message.replace(/\s+$/, '')
    if (!message) throw new Error('Сообщение коммита не может быть пустым')
    commit.message = `${utf8ToLatin1(message)}\n`
  }
  if (edit.authorName !== undefined || edit.authorEmail !== undefined || edit.authorDate !== undefined) {
    commit.author = editIdentity(commit.author, edit.authorName, edit.authorEmail, edit.authorDate)
  }
  if (edit.committerName !== undefined || edit.committerEmail !== undefined || edit.committerDate !== undefined) {
    commit.committer = editIdentity(commit.committer, edit.committerName, edit.committerEmail, edit.committerDate)
  }
}

async function readObjects(cwd: string, shas: string[]): Promise<Map<string, { type: string; data: Buffer }>> {
  const objects = new Map<string, { type: string; data: Buffer }>()
  if (!shas.length) return objects
  const { stdout } = await runGit(cwd, ['cat-file', '--batch'], { input: `${shas.join('\n')}\n` })
  let offset = 0
  for (const sha of shas) {
    const newline = stdout.indexOf(10, offset)
    const header = stdout.subarray(offset, newline).toString('latin1')
    const [, type, size] = header.split(' ')
    if (type === undefined) throw new Error(`Объект не найден: ${sha}`)
    const start = newline + 1
    const end = start + Number(size)
    objects.set(sha, { type, data: stdout.subarray(start, end) })
    offset = end + 1
  }
  return objects
}

/**
 * Git refuses to create objects that fail its format checks, but old repositories legitimately
 * contain such objects: tags with no tagger, commits with odd dates. Rewriting one must not stop
 * the whole history, so a refused write is retried without the format check.
 */
async function hashObjects(cwd: string, type: string, args: string[], input: string | Buffer): Promise<string> {
  const base = ['hash-object', '-t', type, '-w', ...args]
  try {
    return await git(cwd, base, { input })
  } catch (error) {
    if (!(error instanceof GitError) || !/fsck|malformed|corrupt/i.test(error.stderr)) throw error
    return git(cwd, [...base, '--literally'], { input })
  }
}

async function writeObject(cwd: string, type: 'commit' | 'tag', data: Buffer): Promise<string> {
  return (await hashObjects(cwd, type, ['--stdin'], data)).trim()
}

/**
 * Collects objects and writes them in one git process, because one process per object takes
 * minutes on a long history. The SHA is known up front so that children can refer to it.
 * Git still validates every object, and its answer is compared with the computed SHA.
 */
class ObjectBatch {
  private pending: { sha: string; data: Buffer }[] = []

  constructor(private readonly cwd: string, private readonly type: 'commit' | 'tree' | 'tag', private readonly algorithm: string) {}

  add(data: Buffer): string {
    const hash = createHash(this.algorithm)
    hash.update(`${this.type} ${data.length}\0`)
    hash.update(data)
    const sha = hash.digest('hex')
    this.pending.push({ sha, data })
    return sha
  }

  async flush(): Promise<void> {
    if (!this.pending.length) return
    const directory = await mkdtemp(join(tmpdir(), 'chronicle-objects-'))
    try {
      const paths = this.pending.map((_, index) => join(directory, String(index)))
      for (let start = 0; start < paths.length; start += WRITE_CONCURRENCY) {
        await Promise.all(paths.slice(start, start + WRITE_CONCURRENCY).map((path, offset) => writeFile(path, this.pending[start + offset].data)))
      }
      const raw = await hashObjects(this.cwd, this.type, ['--no-filters', '--stdin-paths'], `${paths.join('\n')}\n`)
      const written = raw.split('\n').filter(Boolean)
      this.pending.forEach((item, index) => {
        if (written[index] !== item.sha) throw new Error(`Git записал другой объект: ${written[index]} вместо ${item.sha}`)
      })
      this.pending = []
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

const WRITE_CONCURRENCY = 256

function stripSignatureHeader(commit: Buffer): Buffer {
  const text = commit.toString('latin1')
  const headerEnd = text.indexOf('\n\n')
  const kept = text.slice(0, headerEnd).split('\n').filter((line, index, lines) => {
    if (line.startsWith('gpgsig')) return false
    if (!line.startsWith(' ')) return true
    let previous = index - 1
    while (previous >= 0 && lines[previous].startsWith(' ')) previous--
    return !lines[previous].startsWith('gpgsig')
  })
  return Buffer.from(`${kept.join('\n')}${text.slice(headerEnd)}`, 'latin1')
}

/**
 * Signs through git, so it honours the user's gpg.format, gpg.program and user.signingKey.
 * The result is compared byte for byte with the intended commit. If commit-tree could not
 * reproduce it, for example because of a mergetag header, null is returned and nothing is used.
 */
async function signCommit(cwd: string, commit: RawCommit): Promise<string | null> {
  const identity = (line: string): { name: string; email: string; date: string } | null => {
    const match = /^(.*) <(.*)> (\d+ [+-]\d{4})$/s.exec(line)
    if (!match) return null
    const decode = (value: string): string => Buffer.from(value, 'latin1').toString('utf8')
    return { name: decode(match[1]), email: decode(match[2]), date: `@${match[3]}` }
  }
  const author = identity(commit.author)
  const committer = identity(commit.committer)
  if (!author || !committer) return null
  const args = commit.encoding ? ['-c', `i18n.commitEncoding=${commit.encoding}`] : []
  args.push('commit-tree', '-S', commit.tree)
  for (const parent of commit.parents) args.push('-p', parent)
  let sha: string
  try {
    sha = await gitLine(cwd, args, {
      input: Buffer.from(commit.message, 'latin1'),
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: author.date,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: committer.date
      }
    })
  } catch (error) {
    throw new Error(`Не удалось подписать коммит: ${(error as Error).message}`)
  }
  const written = (await runGit(cwd, ['cat-file', 'commit', sha])).stdout
  return stripSignatureHeader(written).equals(serializeCommit(commit)) ? sha : null
}

export async function signingSetup(cwd: string): Promise<SigningSetup> {
  const read = async (key: string): Promise<string> =>
    (await runGit(cwd, ['config', '--get', key], { okCodes: [1] })).stdout.toString('utf8').trim()
  const key = await read('user.signingkey')
  return { available: Boolean(key), format: (await read('gpg.format')) || 'openpgp', key }
}

/** One long-lived `git cat-file --batch`, for reading many objects one at a time. */
class ObjectReader {
  private readonly child
  private buffer: Buffer = Buffer.alloc(0)
  private readonly waiting: { resolve: (data: Buffer) => void; reject: (error: Error) => void }[] = []

  constructor(cwd: string) {
    this.child = spawnGit(cwd, ['cat-file', '--batch'])
    this.child.stdin.on('error', () => {})
    this.child.stderr.resume()
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
      this.drain()
    })
    this.child.on('close', () => {
      for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('git cat-file завершился раньше времени'))
    })
  }

  private drain(): void {
    while (this.waiting.length) {
      const newline = this.buffer.indexOf(10)
      if (newline === -1) return
      const header = this.buffer.subarray(0, newline).toString('latin1')
      const [name, type, size] = header.split(' ')
      if (type === undefined || type === 'missing') {
        this.buffer = this.buffer.subarray(newline + 1)
        this.waiting.shift()!.reject(new Error(`Объект не найден: ${name}`))
        continue
      }
      const end = newline + 1 + Number(size)
      if (this.buffer.length < end + 1) return
      const data = this.buffer.subarray(newline + 1, end)
      this.buffer = this.buffer.subarray(end + 1)
      this.waiting.shift()!.resolve(data)
    }
  }

  read(sha: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject })
      this.child.stdin.write(`${sha}\n`)
    })
  }

  close(): void {
    this.child.stdin.end()
  }
}

interface MergeOutcome {
  tree: string | null
  files: string[]
  /** The result with conflict markers; present only on a conflict. */
  conflictTree?: string
  details: ConflictFile[]
}

async function mergeTrees(cwd: string, base: string, ours: string, theirs: string): Promise<MergeOutcome> {
  const { stdout, code } = await runGit(
    cwd,
    ['merge-tree', '--write-tree', '--no-messages', '-z', `--merge-base=${base}`, ours, theirs],
    { okCodes: [1] }
  )
  const parts = stdout.toString('utf8').split('\0').filter(Boolean)
  if (code === 0) return { tree: parts[0].trim(), files: [], details: [] }
  const conflictTree = parts[0].trim()
  const byPath = new Map<string, ConflictFile>()
  for (const entry of parts.slice(1)) {
    const tab = entry.indexOf('\t')
    const [, oid, stage] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    const file = byPath.get(path) ?? { path }
    if (stage === '1') file.base = oid
    else if (stage === '2') file.ours = oid
    else if (stage === '3') file.theirs = oid
    byPath.set(path, file)
  }
  for (const file of byPath.values()) {
    const { stdout: merged, code: found } = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `${conflictTree}:${file.path}`], { okCodes: [1] })
    if (found === 0) file.merged = merged.toString('utf8').trim()
  }
  return { tree: null, files: [...byPath.keys()], conflictTree, details: [...byPath.values()] }
}

/** Runs git commands against a throwaway index, so the user's index and files stay untouched. */
async function withTemporaryIndex<T>(
  cwd: string,
  tree: string,
  action: (env: Record<string, string>) => Promise<T>
): Promise<{ result: T; tree: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'chronicle-index-'))
  const env = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await git(cwd, ['read-tree', tree], { env })
    const result = await action(env)
    return { result, tree: await gitLine(cwd, ['write-tree'], { env }) }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function applyResolutions(
  cwd: string,
  outcome: MergeOutcome,
  resolutions: Record<string, ConflictResolution>
): Promise<string> {
  const { tree } = await withTemporaryIndex(cwd, outcome.conflictTree!, async (env) => {
    for (const file of outcome.details) {
      const resolution = resolutions[file.path]
      if ('deleted' in resolution) {
        await git(cwd, ['update-index', '--force-remove', '--', file.path], { env })
        continue
      }
      const blob = 'blob' in resolution
        ? resolution.blob
        : await gitLine(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { input: resolution.content })
      const existing = await git(cwd, ['ls-tree', '-z', outcome.conflictTree!, '--', file.path])
      const mode = existing ? existing.split(' ')[0] : '100644'
      await git(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${file.path}`], { env })
    }
  })
  return tree
}

/** The tree of `tree` plus `patch`, or null when the patch no longer applies. */
async function treeWithPatch(cwd: string, tree: string, patch: string): Promise<string | null> {
  try {
    const applied = await withTemporaryIndex(cwd, tree, (env) =>
      git(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn'], { env, input: patch })
    )
    return applied.tree
  } catch (error) {
    if (error instanceof GitError) return null
    throw error
  }
}

function subjectOf(commit: RawCommit): string {
  return Buffer.from(commit.message, 'latin1').toString('utf8').split('\n')[0]
}

/** Splits a raw tree object into its entries, each still in its original bytes. */
function parseTree(data: Buffer, hashLength: number): { name: string; isTree: boolean; sha: string; raw: Buffer; rawHead: Buffer }[] {
  const entries = []
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(32, offset)
    const nul = data.indexOf(0, space)
    const mode = data.subarray(offset, space).toString('latin1')
    const end = nul + 1 + hashLength
    entries.push({
      name: data.subarray(space + 1, nul).toString('utf8'),
      isTree: mode === '40000',
      sha: data.subarray(nul + 1, end).toString('hex'),
      raw: data.subarray(offset, end),
      rawHead: data.subarray(offset, nul + 1)
    })
    offset = end
  }
  return entries
}

/** Removes paths from trees, sharing work between commits through a cache. */
class TreePruner {
  private readonly cache = new Map<string, string | null>()
  private readonly paths: string[][]
  private readonly hashLength: number

  constructor(
    private readonly reader: ObjectReader,
    private readonly batch: ObjectBatch,
    algorithm: string,
    paths: string[]
  ) {
    this.hashLength = algorithm === 'sha256' ? 32 : 20
    this.paths = paths.map((path) => path.replace(/\\/g, '/').split('/').filter(Boolean))
    if (this.paths.some((parts) => parts.length === 0)) throw new Error('Пустой путь для удаления')
  }

  /** Returns the pruned tree, or null when the tree became empty. */
  async prune(tree: string): Promise<string | null> {
    return this.visit(tree, this.paths)
  }

  private async visit(tree: string, paths: string[][]): Promise<string | null> {
    const key = `${tree}:${paths.map((parts) => parts.join('/')).join('|')}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const entries = parseTree(await this.reader.read(tree), this.hashLength)
    const kept: Buffer[] = []
    let changed = false
    for (const entry of entries) {
      if (paths.some((parts) => parts.length === 1 && parts[0] === entry.name)) {
        changed = true
        continue
      }
      const nested = paths.filter((parts) => parts.length > 1 && parts[0] === entry.name).map((parts) => parts.slice(1))
      if (nested.length && entry.isTree) {
        const next = await this.visit(entry.sha, nested)
        if (next !== entry.sha) changed = true
        if (next) kept.push(entry.rawHead, Buffer.from(next, 'hex'))
      } else {
        kept.push(entry.raw)
      }
    }
    let result: string | null = tree
    if (changed) result = kept.length ? this.batch.add(Buffer.concat(kept)) : null
    this.cache.set(key, result)
    return result
  }
}

function stripTagSignature(data: Buffer): Buffer {
  const text = data.toString('latin1')
  const index = text.search(/-----BEGIN (PGP|SSH) SIGNATURE-----/)
  return index === -1 ? data : Buffer.from(text.slice(0, index), 'latin1')
}

function validateSequence(
  commits: Map<string, RawCommit>,
  chain: string[],
  todo: TodoItem[]
): void {
  const inChain = new Set(chain)
  const seen = new Set<string>()
  for (const item of todo) {
    if (!inChain.has(item.sha)) throw new Error(`Коммит ${item.sha.slice(0, 8)} не входит в выбранный участок`)
    if (seen.has(item.sha)) throw new Error(`Коммит ${item.sha.slice(0, 8)} указан дважды`)
    seen.add(item.sha)
  }
  if (seen.size !== chain.length) throw new Error('В плане указаны не все коммиты участка')
  for (const sha of chain) {
    if ((commits.get(sha)?.parents.length ?? 0) > 1) {
      throw new Error(`Участок содержит merge-коммит ${sha.slice(0, 8)}, его нельзя переставлять`)
    }
  }
  const firstKept = todo.find((item) => item.action !== 'drop')
  if (firstKept && firstKept.action !== 'pick') {
    throw new Error('Первый оставшийся коммит участка нельзя объединить с предыдущим')
  }
  if (todo.some((item) => item.split && item.action !== 'pick')) {
    throw new Error('Разделённый коммит нельзя удалять или объединять')
  }
}

async function chainBetween(
  cwd: string,
  base: string | null,
  tip: string
): Promise<string[]> {
  const range = base ? [`${base}..${tip}`] : [tip]
  const raw = await git(cwd, ['rev-list', '--topo-order', '--reverse', '--first-parent', ...range, '--'])
  return raw.split('\n').filter(Boolean)
}

const EMPTY_TREE_INPUT = ''

/**
 * Builds the rewritten history as unreferenced objects and reports what applying it would do.
 * It moves no refs, so calling it is always safe.
 */
export async function previewRewrite(
  cwd: string,
  plan: RewritePlan,
  options: { sign?: boolean } = {}
): Promise<RewritePreview> {
  const refs = (await readRefs(cwd)).filter((ref) => ref.kind !== 'remote')
  const conflicts: RewriteConflict[] = []
  const warnings: string[] = []
  const signaturesLost: string[] = []
  const emptyTree = await gitLine(cwd, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: EMPTY_TREE_INPUT })
  const edits = plan.edits ?? {}
  const algorithm = await gitLine(cwd, ['rev-parse', '--show-object-format'])
  const batch = new ObjectBatch(cwd, 'commit', algorithm)
  const treeBatch = new ObjectBatch(cwd, 'tree', algorithm)
  const reader = plan.removePaths?.length ? new ObjectReader(cwd) : null
  const pruner = reader ? new TreePruner(reader, treeBatch, algorithm, plan.removePaths!) : null
  const prune = plan.pruneEmpty ?? false

  // Graph of everything reachable from local refs, parents listed before children.
  const tips = [...new Set(refs.map((ref) => ref.target))]
  const headSha = (await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] })).stdout.toString('utf8').trim()
  const graphRaw = tips.length
    ? await git(cwd, ['rev-list', '--parents', '--topo-order', '--reverse', '--stdin'], { input: `${tips.join('\n')}\n` })
    : ''
  const order: string[] = []
  const parentsOf = new Map<string, string[]>()
  for (const line of graphRaw.split('\n')) {
    if (!line) continue
    const [sha, ...parents] = line.split(' ')
    order.push(sha)
    parentsOf.set(sha, parents)
  }

  // Seeds: commits that change directly. Their descendants change because their parents do.
  const seeds = new Set<string>(Object.keys(edits))
  let chain: string[] = []
  const onto = plan.sequence?.onto ? await revParse(cwd, plan.sequence.onto) : null
  if (plan.sequence?.onto && !onto) throw new Error(`Не найден коммит ${plan.sequence.onto}`)
  if (onto && (await isAncestor(cwd, plan.sequence!.tip, onto))) {
    throw new Error('Ветка уже входит в историю целевой ветки, переносить нечего')
  }
  if (plan.sequence) {
    chain = await chainBetween(cwd, plan.sequence.base, plan.sequence.tip)
    if (chain.at(-1) !== plan.sequence.tip) throw new Error('Вершина участка указана неверно')
    if (chain.length && (parentsOf.get(chain[0])?.[0] ?? null) !== plan.sequence.base) {
      throw new Error('Основание участка указано неверно')
    }
    chain.forEach((sha) => seeds.add(sha))
  }
  if (pruner) order.forEach((sha) => seeds.add(sha))
  for (const sha of seeds) {
    if (!parentsOf.has(sha)) throw new Error(`Коммит ${sha.slice(0, 8)} недоступен из локальных веток и тегов`)
  }
  const affected = new Set<string>(seeds)
  for (const sha of order) {
    if (parentsOf.get(sha)!.some((parent) => affected.has(parent))) affected.add(sha)
  }
  const toRead = [...affected]
  for (const sha of affected) for (const parent of parentsOf.get(sha)!) toRead.push(parent)
  if (onto) toRead.push(onto)
  const objects = await readObjects(cwd, [...new Set(toRead)])
  const commits = new Map<string, RawCommit>()
  for (const [sha, object] of objects) commits.set(sha, parseRawCommit(sha, object.data))

  const mapping = new Map<string, string | null>()
  const treeOfNew = new Map<string, string>()
  const mapped = (sha: string): string | null => (mapping.has(sha) ? mapping.get(sha)! : sha)
  const treeOf = (sha: string | null): string => {
    if (!sha) return emptyTree
    const known = treeOfNew.get(sha) ?? commits.get(sha)?.tree
    if (!known) throw new Error(`Неизвестное дерево коммита ${sha}`)
    return known
  }

  let unsignable = 0
  let alreadyThere = 0
  const write = async (source: RawCommit, parents: string[], tree: string, edit?: CommitEdit): Promise<string> => {
    const next: RawCommit = { ...source, parents, tree, extraHeaders: [...source.extraHeaders] }
    applyEdit(next, edit)
    const unchanged =
      next.tree === source.tree &&
      next.parents.join() === source.parents.join() &&
      next.author === source.author &&
      next.committer === source.committer &&
      next.message === source.message
    if (unchanged) return source.sha
    if (source.signed && options.sign) {
      // A signature changes the SHA, so children must see the signed commit. Signing needs the
      // parents on disk, which is why the batch is written first.
      await treeBatch.flush()
      await batch.flush()
      const signed = await signCommit(cwd, next)
      if (signed) {
        treeOfNew.set(signed, tree)
        return signed
      }
      unsignable++
    }
    if (source.signed) signaturesLost.push(source.sha)
    const sha = batch.add(serializeCommit(next))
    treeOfNew.set(sha, tree)
    return sha
  }

  /** Tree of `source` replayed on top of `onto`. Null means a conflict was recorded. */
  const replayTree = async (source: RawCommit, onto: string | null): Promise<string | null> => {
    const parentTree = source.parents.length ? treeOf(source.parents[0]) : emptyTree
    const ontoTree = treeOf(onto)
    if (parentTree === ontoTree) return source.tree
    if (source.tree === parentTree) return ontoTree
    return mergeOrResolve(source, parentTree, ontoTree)
  }

  /** Merges a commit's change, using the user's earlier answers if they cover every file. */
  const mergeOrResolve = async (source: RawCommit, base: string, ours: string): Promise<string | null> => {
    const merged = await mergeTrees(cwd, base, ours, source.tree)
    if (merged.tree) return merged.tree
    const answers = plan.resolutions?.[source.sha]
    if (answers && merged.details.every((file) => answers[file.path])) {
      return applyResolutions(cwd, merged, answers)
    }
    conflicts.push({ sha: source.sha, subject: subjectOf(source), files: merged.files, details: merged.details, reason: 'content' })
    return null
  }

  const processSequence = async (): Promise<boolean> => {
    const { base, todo } = plan.sequence!
    validateSequence(commits, chain, todo)
    let current = onto ?? (base ? mapped(base) : null)
    let group: { head: RawCommit; parent: string | null; tree: string; messages: string[]; members: string[] } | null = null
    const flush = async (): Promise<void> => {
      if (!group) return
      const edit = edits[group.head.sha]
      const message = edit?.message !== undefined || group.messages.length === 1
        ? edit
        : { ...edit, message: Buffer.from(group.messages.join('\n\n'), 'latin1').toString('utf8') }
      const sha = await write(group.head, group.parent ? [group.parent] : [], group.tree, message)
      for (const member of group.members) mapping.set(member, sha)
      current = sha
      group = null
    }
    for (const item of todo) {
      const source = commits.get(item.sha)!
      if (item.action === 'drop') {
        await flush()
        mapping.set(item.sha, current)
        continue
      }
      if (item.action === 'pick') {
        await flush()
        const tree = await replayTree(source, current)
        if (tree === null) return false
        // Moved onto another branch, a commit whose change is already there would become empty.
        const ownParentTree = source.parents.length ? treeOf(source.parents[0]) : emptyTree
        if (onto && !item.split && tree === treeOf(current) && source.tree !== ownParentTree) {
          mapping.set(item.sha, current)
          alreadyThere++
          continue
        }
        if (item.split) {
          const firstTree = await treeWithPatch(cwd, treeOf(current), item.split.patch)
          if (!firstTree) {
            conflicts.push({ sha: source.sha, subject: subjectOf(source), files: [], reason: 'split' })
            return false
          }
          current = await write(source, current ? [current] : [], firstTree, { ...edits[item.sha], message: item.split.message })
        }
        group = {
          head: source, parent: current, tree,
          messages: [source.message.replace(/\s+$/, '')],
          members: [item.sha]
        }
        continue
      }
      // Squash and fixup replay onto the group's tree without creating an intermediate commit.
      if (!group) throw new Error('Нет коммита, с которым можно объединить')
      const parentTree = source.parents.length ? treeOf(source.parents[0]) : emptyTree
      let tree: string | null = source.tree
      if (parentTree !== group.tree) {
        tree = await mergeOrResolve(source, parentTree, group.tree)
        if (tree === null) return false
      }
      group.tree = tree
      group.members.push(item.sha)
      if (item.action === 'squash') group.messages.push(source.message.replace(/\s+$/, ''))
      if (source.signed) signaturesLost.push(source.sha)
    }
    await flush()
    // Whatever sat on top of the old tip now sits on top of the whole sequence, wherever
    // the commit that used to be the tip ended up.
    mapping.set(plan.sequence!.tip, current)
    return true
  }

  let sequenceDone = !plan.sequence
  const chainSet = new Set(chain)
  try {
  for (const sha of order) {
    if (!affected.has(sha)) continue
    if (chainSet.has(sha)) {
      if (!sequenceDone) {
        sequenceDone = true
        if (!(await processSequence())) break
      }
      continue
    }
    const source = commits.get(sha)!
    const newParents = [...new Set(source.parents.map(mapped).filter((parent): parent is string => parent !== null))]
    let tree: string | null
    if (pruner) {
      tree = (await pruner.prune(source.tree)) ?? emptyTree
      if (prune && source.parents.length <= 1) {
        const parentTree = newParents.length ? treeOf(newParents[0]) : emptyTree
        const originalParentTree = source.parents.length ? treeOf(source.parents[0]) : emptyTree
        if (tree === parentTree && source.tree !== originalParentTree) {
          mapping.set(sha, newParents[0] ?? null)
          continue
        }
      }
    } else if (source.parents.length <= 1) {
      tree = await replayTree(source, newParents[0] ?? null)
      if (tree === null) break
    } else {
      const contentMoved = source.parents.some((parent) => treeOf(mapped(parent)) !== treeOf(parent))
      if (contentMoved) {
        conflicts.push({ sha, subject: subjectOf(source), files: [], reason: 'merge-commit' })
        break
      }
      tree = source.tree
    }
    mapping.set(sha, await write(source, newParents, tree, edits[sha]))
  }
  } finally {
    reader?.close()
  }
  await treeBatch.flush()
  await batch.flush()

  // Ref updates.
  const refUpdates: RefUpdate[] = []
  const blockers: string[] = []
  const tagBatch = new ObjectBatch(cwd, 'tag', algorithm)
  const tagReader = new ObjectReader(cwd)
  /** Rebuilds an annotated tag on its new target, following tags that point at tags. */
  const rewriteTag = async (sha: string, name: string): Promise<string> => {
    const data = await tagReader.read(sha)
    const text = data.toString('latin1')
    const head = /^object (\S+)\ntype (\S+)\n/.exec(text)
    if (!head) throw new Error(`Не удалось разобрать тег ${name}`)
    const inner = head[2] === 'tag' ? await rewriteTag(head[1], name) : mapped(head[1])
    if (!inner || inner === head[1]) return sha
    const stripped = stripTagSignature(data)
    if (stripped.length !== data.length) warnings.push(`Подпись тега ${name} будет снята`)
    const rest = stripped.toString('latin1').slice(`object ${head[1]}\n`.length)
    return tagBatch.add(Buffer.from(`object ${inner}\n${rest}`, 'latin1'))
  }
  if (!conflicts.length) {
    for (const ref of refs) {
      if (!mapping.has(ref.target)) continue
      const target = mapping.get(ref.target)!
      if (target === ref.target) continue
      if (target === null) {
        blockers.push(
          ref.kind === 'branch'
            ? `В ветке ${ref.name} не останется коммитов`
            : `Тег ${ref.name} не на что перенести, сначала удали его`
        )
        continue
      }
      const after = ref.kind === 'tag' && ref.sha !== ref.target ? await rewriteTag(ref.sha, ref.name) : target
      const update: RefUpdate = {
        ref: ref.ref,
        name: ref.name,
        kind: ref.kind === 'branch' ? 'branch' : 'tag',
        before: ref.sha,
        after,
        beforeCommit: ref.target,
        afterCommit: target
      }
      if (ref.upstream && !ref.upstreamGone) {
        update.upstream = ref.upstream
        update.needsForcePush = !(await isAncestor(cwd, `refs/remotes/${ref.upstream}`, target))
      }
      refUpdates.push(update)
    }
  }
  tagReader.close()
  await tagBatch.flush()

  // Environment checks.
  const operation = await readOperation(cwd)
  if (operation) blockers.push(`Сначала заверши или отмени текущую операцию: ${operation}`)
  const status = await readStatus(cwd)
  let worktreeChanges = false
  const headUpdate = refUpdates.find((update) => update.kind === 'branch' && status.head === update.name)
  if (headUpdate) {
    worktreeChanges = treeOf(headUpdate.afterCommit) !== treeOf(headUpdate.beforeCommit)
    const dirty = status.files.some((file) => file.unstaged !== 'untracked')
    if (worktreeChanges && dirty) {
      blockers.push('Содержимое текущей ветки изменится, а в рабочей папке есть незакоммиченные правки. Сохрани их в stash или закоммить.')
    }
  }
  if (status.detached && headSha && mapping.has(headSha) && mapping.get(headSha) !== headSha) {
    warnings.push('HEAD отсоединён и останется на старом коммите')
  }
  const worktrees = await git(cwd, ['worktree', 'list', '--porcelain'])
  const others = worktrees.split('\n\n').slice(1)
  for (const block of others) {
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
    if (branch && refUpdates.some((update) => update.kind === 'branch' && update.name === branch)) {
      blockers.push(`Ветка ${branch} открыта в другом worktree`)
    }
  }
  if (refUpdates.some((update) => update.needsForcePush)) {
    warnings.push('Изменятся уже запушенные коммиты. После применения потребуется force-push.')
  }
  if (pruner) {
    warnings.push('Старые версии файлов останутся в резервных копиях, reflog и stash, пока ты их не очистишь. Утёкшие секреты нужно отозвать.')
  }
  if (alreadyThere) warnings.push(`Изменения из коммитов уже есть в целевой ветке, они будут пропущены: ${alreadyThere}`)
  const lost = [...new Set(signaturesLost)]
  if (lost.length) warnings.push(`Подпись снимется с коммитов: ${lost.length}`)
  if (unsignable) warnings.push(`Не удалось подписать заново коммитов необычного формата: ${unsignable}`)

  const mappingRecord: Record<string, string | null> = {}
  let rewrittenCount = 0
  for (const [oldSha, newSha] of mapping) {
    if (oldSha !== newSha) {
      mappingRecord[oldSha] = newSha
      rewrittenCount++
    }
  }
  return {
    mapping: mappingRecord,
    refUpdates,
    rewrittenCount,
    conflicts,
    warnings,
    blockers,
    signaturesLost: lost,
    worktreeChanges,
    description: plan.description ?? 'Правка истории'
  }
}

/** The commits a branch would carry onto `onto`, from where the two histories split. */
export async function rebaseRange(cwd: string, branch: string, onto: string): Promise<RebaseRange> {
  const tip = await revParse(cwd, `refs/heads/${branch}`)
  if (!tip) throw new Error(`Ветка ${branch} не найдена`)
  const ontoSha = await revParse(cwd, onto)
  if (!ontoSha) throw new Error(`Не найдено: ${onto}`)
  const { stdout, code } = await runGit(cwd, ['merge-base', tip, ontoSha], { okCodes: [1] })
  const base = code === 0 ? stdout.toString('utf8').trim() : null
  const range = base ? [`${base}..${tip}`] : [tip]
  const all = await readCommits(cwd, ['--reverse', ...range])
  const firstParent = new Set((await git(cwd, ['rev-list', '--first-parent', ...range, '--'])).split('\n').filter(Boolean))
  return {
    branch,
    tip,
    base,
    onto: ontoSha,
    commits: all.filter((commit) => firstParent.has(commit.sha)),
    upToDate: base === ontoSha,
    hasMerges: all.some((commit) => commit.parents.length > 1)
  }
}

export interface ReplayResult {
  tip: string | null
  conflict?: RewriteConflict
}

/** Replays commits, oldest first, on top of `onto`, without touching any ref. */
export async function replayOnto(
  cwd: string,
  shas: string[],
  onto: string,
  editFor: (sha: string) => CommitEdit | undefined = () => undefined
): Promise<ReplayResult> {
  const objects = await readObjects(cwd, [onto, ...shas])
  const parse = (sha: string): RawCommit => parseRawCommit(sha, objects.get(sha)!.data)
  let current = onto
  let currentTree = parse(onto).tree
  for (const sha of shas) {
    const source = parse(sha)
    const parent = source.parents[0]
    const parentTree = parent ? await gitLine(cwd, ['rev-parse', `${parent}^{tree}`]) : ''
    let tree = source.tree
    if (parentTree !== currentTree) {
      const merged = await mergeTrees(cwd, parentTree, currentTree, source.tree)
      if (!merged.tree) {
        return { tip: null, conflict: { sha, subject: subjectOf(source), files: merged.files, reason: 'content' } }
      }
      tree = merged.tree
    }
    const edit = editFor(sha)
    const next: RawCommit = { ...source, parents: [current], tree }
    applyEdit(next, edit)
    const unchanged = parent === current && next.author === source.author && next.committer === source.committer && next.message === source.message && tree === source.tree
    current = unchanged ? sha : await writeObject(cwd, 'commit', serializeCommit(next))
    currentTree = tree
  }
  return { tip: current }
}

// Journal and atomic ref moves.

const JOURNAL_LIMIT = 200

async function journalPath(cwd: string): Promise<string> {
  return join(await commonDir(cwd), 'chronicle', 'journal.json')
}

export async function readJournal(cwd: string): Promise<JournalEntry[]> {
  try {
    return JSON.parse(await readFile(await journalPath(cwd), 'utf8')) as JournalEntry[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeJournal(cwd: string, entries: JournalEntry[]): Promise<void> {
  const path = await journalPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(entries.slice(-JOURNAL_LIMIT), null, 2))
  await rename(temporary, path)
}

interface RefMove {
  ref: string
  before: string | null
  after: string | null
}

function commitOfRef(sha: string): string {
  return `${sha}^{commit}`
}

/**
 * Moves refs atomically and brings the checked-out files along. Each move is a compare-and-swap,
 * so nothing changes if another process moved a ref in the meantime.
 */
export async function moveRefs(
  cwd: string,
  moves: RefMove[],
  description: string,
  options: { record?: boolean } = {}
): Promise<JournalEntry> {
  const status = await readStatus(cwd)
  const headRef = status.head ? `refs/heads/${status.head}` : null
  const headMove = moves.find((move) => move.ref === headRef)
  let treesMoved: { from: string; to: string } | null = null
  if (headMove && headMove.before && headMove.after) {
    const from = await gitLine(cwd, ['rev-parse', `${commitOfRef(headMove.before)}^{tree}`])
    const to = await gitLine(cwd, ['rev-parse', `${commitOfRef(headMove.after)}^{tree}`])
    if (from !== to) {
      if (status.files.some((file) => file.unstaged !== 'untracked')) {
        throw new Error('В рабочей папке есть незакоммиченные правки. Сохрани их в stash или закоммить.')
      }
      treesMoved = { from, to }
    }
  }
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const stdin: string[] = ['start']
  for (const move of moves) {
    const zero = '0'.repeat((move.before ?? move.after)!.length)
    stdin.push(`update ${move.ref} ${move.after ?? zero} ${move.before ?? zero}`)
    if (move.before) stdin.push(`update refs/chronicle/backup/${id}/${move.ref.replace(/^refs\//, '')} ${move.before}`)
  }
  stdin.push('prepare', 'commit')
  if (treesMoved) await git(cwd, ['read-tree', '-m', '-u', treesMoved.from, treesMoved.to])
  try {
    await git(cwd, ['update-ref', '--create-reflog', '-m', `chronicle: ${description}`, '--stdin'], {
      input: `${stdin.join('\n')}\n`
    })
  } catch (error) {
    if (treesMoved) await git(cwd, ['read-tree', '-m', '-u', treesMoved.to, treesMoved.from])
    throw error
  }
  const entry: JournalEntry = {
    id,
    at: new Date().toISOString(),
    description,
    updates: moves.map((move) => ({ ref: move.ref, before: move.before, after: move.after })),
    state: 'applied'
  }
  if (options.record !== false) await writeJournal(cwd, [...(await readJournal(cwd)), entry])
  return entry
}

export async function applyRewrite(cwd: string, plan: RewritePlan): Promise<{ entry: JournalEntry; preview: RewritePreview }> {
  const preview = await previewRewrite(cwd, plan, { sign: plan.resign })
  if (preview.conflicts.length) throw new Error(`Конфликт в коммите ${preview.conflicts[0].sha.slice(0, 8)}: ${preview.conflicts[0].subject}`)
  if (preview.blockers.length) throw new Error(preview.blockers[0])
  if (!preview.refUpdates.length) throw new Error('План ничего не меняет')
  const entry = await moveRefs(
    cwd,
    preview.refUpdates.map((update) => ({ ref: update.ref, before: update.before, after: update.after })),
    preview.description
  )
  return { entry, preview }
}

async function revertMoves(cwd: string, id: string, direction: 'undo' | 'redo'): Promise<JournalEntry> {
  const journal = await readJournal(cwd)
  const entry = journal.find((item) => item.id === id)
  if (!entry) throw new Error('Запись журнала не найдена')
  const expected = direction === 'undo' ? 'applied' : 'undone'
  if (entry.state !== expected) throw new Error('Эта запись уже в нужном состоянии')
  const moves: RefMove[] = entry.updates.map((update) => ({
    ref: update.ref,
    before: direction === 'undo' ? update.after : update.before,
    after: direction === 'undo' ? update.before : update.after
  }))
  try {
    await moveRefs(cwd, moves, `${direction === 'undo' ? 'Отмена' : 'Повтор'}: ${entry.description}`, { record: false })
  } catch (error) {
    if (error instanceof GitError) {
      throw new Error('Ветки изменились после этой операции. Отмена потеряла бы новые коммиты, поэтому она не выполнена.')
    }
    throw error
  }
  entry.state = direction === 'undo' ? 'undone' : 'applied'
  await writeJournal(cwd, journal)
  return entry
}

export function undoEntry(cwd: string, id: string): Promise<JournalEntry> {
  return revertMoves(cwd, id, 'undo')
}

export function redoEntry(cwd: string, id: string): Promise<JournalEntry> {
  return revertMoves(cwd, id, 'redo')
}

/**
 * Tags on the server that still hold a value this repository rewrote. A tag the server
 * moved on its own is not listed, because force-pushing it would discard someone's change.
 */
export async function rewrittenTagsOnRemote(cwd: string, remote: string): Promise<{ name: string; expected: string }[]> {
  const raw = await git(cwd, ['ls-remote', '--tags', '--', remote])
  const before = new Set<string>()
  for (const entry of await readJournal(cwd)) {
    if (entry.state !== 'applied') continue
    for (const update of entry.updates) if (update.ref.startsWith('refs/tags/') && update.before) before.add(`${update.ref} ${update.before}`)
  }
  const local = new Map((await readRefs(cwd)).filter((ref) => ref.kind === 'tag').map((ref) => [ref.ref, ref.sha]))
  const tags: { name: string; expected: string }[] = []
  for (const line of raw.split('\n')) {
    const [sha, ref] = line.split('\t')
    if (!ref || ref.endsWith('^{}')) continue
    if (before.has(`${ref} ${sha}`) && local.has(ref) && local.get(ref) !== sha) {
      tags.push({ name: ref.replace('refs/tags/', ''), expected: sha })
    }
  }
  return tags
}

/** Deletes backups and unreachable objects. Required after purging a secret from history. */
export async function purgeBackups(cwd: string): Promise<void> {
  const raw = await git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/chronicle/backup'])
  const stdin = raw.split('\n').filter(Boolean).map((ref) => `delete ${ref}`).join('\n')
  if (stdin) await git(cwd, ['update-ref', '--stdin'], { input: `${stdin}\n` })
  await writeJournal(cwd, [])
  await git(cwd, ['reflog', 'expire', '--expire=now', '--all'])
  await git(cwd, ['gc', '--prune=now', '--quiet'])
}

