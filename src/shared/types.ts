export interface Commit {
  sha: string
  parents: string[]
  tree: string
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerEmail: string
  committerDate: string
  subject: string
  message: string
}

type RefKind = 'branch' | 'remote' | 'tag'

export interface RefInfo {
  ref: string
  name: string
  kind: RefKind
  sha: string
  /** Commit the ref points to; differs from sha for annotated tags. */
  target: string
  upstream?: string
  ahead?: number
  behind?: number
  upstreamGone?: boolean
  isHead?: boolean
  date?: string
}

export interface RemoteInfo {
  name: string
  fetchUrl: string
  pushUrl: string
  defaultBranch?: string
}

export type FileState = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'conflicted' | 'untracked'

export interface StatusFile {
  path: string
  origPath?: string
  staged?: FileState
  unstaged?: FileState
}

export type OperationInProgress = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface RepoStatus {
  head: string | null
  headSha: string | null
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  files: StatusFile[]
  operation?: OperationInProgress
}

export interface StashEntry {
  ref: string
  index: number
  sha: string
  message: string
  date: string
  branch?: string
}

export interface DiffLine {
  type: 'context' | 'add' | 'del' | 'note'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'
  binary: boolean
  additions: number
  deletions: number
  /** Raw patch lines before the first hunk. */
  header: string[]
  hunks: DiffHunk[]
}

export interface DiffResult {
  files: FileDiff[]
  truncated: boolean
}

export interface DiffOptions {
  ignoreWhitespace?: boolean
}

/** Where a diff came from, so both versions of a file in it can be read again. */
export type DiffSource =
  | { kind: 'commit'; sha: string }
  | { kind: 'stash'; sha: string }
  | { kind: 'worktree'; staged: boolean; untracked: boolean }

/** A changed image before and after, as data URLs; null where that version does not exist. */
export interface ImageVersions {
  before: string | null
  after: string | null
  /** One of the versions is too big to show. */
  tooLarge: boolean
}

/** Editable commit metadata. Omitted fields stay untouched. */
export interface CommitEdit {
  message?: string
  authorName?: string
  authorEmail?: string
  authorDate?: string
  committerName?: string
  committerEmail?: string
  committerDate?: string
}

export type TodoAction = 'pick' | 'squash' | 'fixup' | 'drop'

/** Splits a commit in two: the patch and message become a new commit right below the rest. */
export interface CommitSplit {
  patch: string
  message: string
}

export interface TodoItem {
  sha: string
  action: TodoAction
  split?: CommitSplit
}

/** A new order for the linear range base..tip of a branch, oldest first. */
interface RewriteSequence {
  base: string | null
  tip: string
  todo: TodoItem[]
  /** A commit to rebuild the range on, instead of its own base: moving a branch onto another. */
  onto?: string
}

/** What merging `ref` into the current branch would do, worked out without touching anything. */
export interface MergePreview {
  ref: string
  head: string
  target: string
  /** The branch already contains everything. */
  upToDate: boolean
  /** The branch can simply move forward to the target. */
  fastForward: boolean
  /** Commits the merge brings in, newest first, at most a page. */
  incoming: Commit[]
  incomingCount: number
  /** Commits only the current branch has. */
  localCount: number
  /** Files both sides changed in ways git cannot combine. */
  conflicts: string[]
}

export type MergeMode = 'auto' | 'no-ff' | 'squash'

/** What moving a branch onto another would take. Commits are oldest first. */
export interface RebaseRange {
  branch: string
  tip: string
  /** Where the branch left the target. Null when they share no history. */
  base: string | null
  onto: string
  commits: Commit[]
  /** The branch already starts from the target, so there is nothing to move. */
  upToDate: boolean
  /** The branch contains merge commits, which a move cannot rebuild exactly. */
  hasMerges: boolean
}

export interface RewritePlan {
  edits?: Record<string, CommitEdit>
  sequence?: RewriteSequence
  removePaths?: string[]
  pruneEmpty?: boolean
  description?: string
  /** On apply, sign again with the user's key the commits that would lose a signature. */
  resign?: boolean
  /** Conflict answers by commit and path, from an earlier preview of this same plan. */
  resolutions?: Record<string, Record<string, ConflictResolution>>
}

export type ConflictResolution = { content: string } | { blob: string } | { deleted: true }

/** Blob ids of one conflicted file. A missing side means the file does not exist there. */
export interface ConflictFile {
  path: string
  base?: string
  ours?: string
  theirs?: string
  /** The file with conflict markers. */
  merged?: string
}

export interface RewriteConflict {
  sha: string
  subject: string
  files: string[]
  reason: 'content' | 'merge-commit' | 'split'
  details?: ConflictFile[]
}

export interface RefUpdate {
  ref: string
  name: string
  kind: 'branch' | 'tag'
  before: string
  after: string
  /** Commit behind `after`; equals `after` unless the ref is an annotated tag. */
  afterCommit: string
  beforeCommit: string
  upstream?: string
  /** True when the upstream would no longer be an ancestor, so force-push is required. */
  needsForcePush?: boolean
}

export interface RewritePreview {
  mapping: Record<string, string | null>
  refUpdates: RefUpdate[]
  rewrittenCount: number
  /** Commits written by this rewrite. Mapping values can also be old commits, such as where a dropped one went. */
  created: string[]
  conflicts: RewriteConflict[]
  warnings: string[]
  blockers: string[]
  signaturesLost: string[]
  worktreeChanges: boolean
  description: string
}

export interface JournalEntry {
  id: string
  at: string
  description: string
  updates: { ref: string; before: string | null; after: string | null }[]
  state: 'applied' | 'undone'
}

export interface PushPreview {
  branch: string
  remote: string
  remoteBranch: string
  remoteSha: string | null
  trackedSha: string | null
  localSha: string
  appear: Commit[]
  vanish: Commit[]
  /** The server moved since the last fetch, so a force-push would discard unseen work. */
  remoteMoved: boolean
  isDefaultBranch: boolean
  needsForce: boolean
}

export interface ScheduledPublish {
  id: string
  repo: string
  branch: string
  remote: string
  at: string
  dateMode: 'keep' | 'publish-time'
  base: string
  tip: string
  commits: { sha: string; subject: string }[]
  state: 'pending' | 'done' | 'failed' | 'cancelled'
  error?: string
  publishedSha?: string
  note?: string
}

export interface RenameBranchResult {
  localRenamed: boolean
  remoteCreated: boolean
  remoteDeleted: boolean
  warnings: string[]
}

/** One version of a file in its history. The path can differ between versions after a rename. */
export interface FileVersion {
  commit: Commit
  path: string
  status: FileState
}

export interface BlameCommit {
  sha: string
  authorName: string
  authorEmail: string
  /** ISO date of the author. */
  authorDate: string
  summary: string
}

export interface BlameLine {
  sha: string
  /** Line number in this version of the file, from 1. */
  line: number
  text: string
}

export interface BlameResult {
  lines: BlameLine[]
  commits: Record<string, BlameCommit>
  /** The file is binary or too big to show line by line. */
  skipped?: 'binary' | 'too-large'
}

export interface Worktree {
  path: string
  head: string | null
  /** Null for a detached checkout. */
  branch: string | null
  main: boolean
  /** The checkout open in this window. */
  current: boolean
  locked: boolean
  /** Its folder is gone, so git can forget it. */
  prunable: boolean
  bare: boolean
}

export interface Submodule {
  path: string
  sha: string
  /** Missing: not downloaded. Changed: a different commit is checked out than the one recorded. */
  state: 'ok' | 'missing' | 'changed' | 'conflict'
  url: string | null
  describe: string | null
}

export interface LfsInfo {
  installed: boolean
  used: boolean
  patterns: string[]
  files: { path: string; downloaded: boolean }[]
}

export interface BlobContent {
  text: string
  binary: boolean
  tooLarge: boolean
}

export type ForgeKind = 'github' | 'gitlab'

export interface ForgeContext {
  /** Read from the server's name, so an unusual self-hosted name gives null. */
  kind: ForgeKind | null
  host: string
  path: string
  webUrl: string
  remote: string
  url: string
}

export interface SigningSetup {
  available: boolean
  format: string
  key: string
}

export interface UpdateInfo {
  current: string
  latest: string | null
  available: boolean
  url: string | null
}

export type Theme = 'system' | 'light' | 'dark'

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark'
}
