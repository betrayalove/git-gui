import { join } from 'node:path'
import { app } from 'electron'
import * as dependencies from '../core/dependencies'
import * as depsFix from '../core/deps-fix'
import * as forge from '../core/forge'
import * as ops from '../core/ops'
import * as read from '../core/read'
import * as rewrite from '../core/rewrite'
import * as schedule from '../core/schedule'
import * as ssh from '../core/ssh'
import * as workspace from '../core/workspace'
import { withoutPrompts } from '../core/git'
import type { AccessPrompt, PromptReply, SshTarget } from '../shared/access'
import type { Language } from '../shared/i18n'
import type { DependencyFix, DependencyReport } from '../shared/deps'
import type { ForgeContext, Theme, UpdateInfo, RepoStatus, RefInfo, RemoteInfo, StashEntry, JournalEntry, ScheduledPublish } from '../shared/types'

const dependencyCache = (): string => join(app.getPath('userData'), 'dependencies')
// Tests answer for all three public databases from one local server.
const dependencySources = (): dependencies.Sources | undefined => {
  const server = process.env.CHRONICLE_DEPS_SERVER
  return server ? { osv: server, depsDev: server, endOfLife: server } : undefined
}

export interface RepoSnapshot {
  status: RepoStatus
  refs: RefInfo[]
  remotes: RemoteInfo[]
  stashes: StashEntry[]
  journal: JournalEntry[]
  schedules: ScheduledPublish[]
  forge: ForgeContext | null
}

/** Everything the interface may call. The first argument is always the repository path. */
export const api = {
  snapshot: async (repo: string): Promise<RepoSnapshot> => {
    const remoteList = read.readRemotes(repo)
    const [status, refs, remotes, stashes, journal, schedules, forgeInfo] = await Promise.all([
      read.readStatus(repo),
      read.readRefs(repo),
      remoteList,
      read.readStashes(repo),
      rewrite.readJournal(repo),
      schedule.listSchedules(repo),
      remoteList.then((list) => forge.forgeContext(repo, undefined, list)).catch(() => null)
    ])
    return { status, refs, remotes, stashes, journal, schedules, forge: forgeInfo }
  },
  /** Cheap enough to ask every few seconds. When it changes, the snapshot is worth reading again. */
  fingerprint: read.repoFingerprint,
  readLog: read.readLog,
  commitDiff: read.commitDiff,
  stashDiff: read.stashDiff,
  worktreeDiff: read.worktreeDiff,
  readBlob: read.readBlob,
  readImageVersions: read.readImageVersions,
  searchChanges: read.searchChanges,
  listFiles: read.listFiles,
  fileHistory: read.fileHistory,
  blameFile: read.blameFile,

  stageFiles: ops.stageFiles,
  stageAll: ops.stageAll,
  unstageFiles: ops.unstageFiles,
  discardFiles: ops.discardFiles,
  applyPatch: ops.applyPatch,
  readWorktreeConflicts: ops.readWorktreeConflicts,
  resolveWorktreeConflict: ops.resolveWorktreeConflict,
  continueOperation: ops.continueOperation,
  commit: ops.commit,
  checkout: ops.checkout,
  checkoutCommit: ops.checkoutCommit,
  checkoutRemoteBranch: ops.checkoutRemoteBranch,
  createBranch: ops.createBranch,
  deleteBranch: ops.deleteBranch,
  mergeBranch: ops.mergeBranch,
  mergePreview: ops.mergePreview,
  listWorktrees: workspace.listWorktrees,
  addWorktree: workspace.addWorktree,
  removeWorktree: workspace.removeWorktree,
  pruneWorktrees: workspace.pruneWorktrees,
  listSubmodules: workspace.listSubmodules,
  updateSubmodules: workspace.updateSubmodules,
  lfsInfo: workspace.lfsInfo,
  lfsPull: workspace.lfsPull,
  lfsTrack: workspace.lfsTrack,
  abortOperation: ops.abortOperation,
  cherryPick: ops.cherryPick,
  revertCommit: ops.revertCommit,
  resetTo: ops.resetTo,
  createTag: ops.createTag,
  deleteTag: ops.deleteTag,
  stashPush: ops.stashPush,
  stashApply: ops.stashApply,
  stashDrop: ops.stashDrop,
  stashClear: ops.stashClear,
  stashToBranch: ops.stashToBranch,
  fetchAll: ops.fetchAll,
  pull: ops.pull,
  push: ops.push,
  pushPreview: ops.pushPreview,
  forcePush: ops.forcePush,
  addRemote: ops.addRemote,
  removeRemote: ops.removeRemote,
  renameBranch: ops.renameBranch,
  renameRemoteBranch: ops.renameRemoteBranch,
  deleteRemoteBranch: ops.deleteRemoteBranch,
  setRemoteUrl: ops.setRemoteUrl,
  readIdentity: ops.readIdentity,
  setIdentity: ops.setIdentity,

  repoKeyPath: ssh.repoKeyPath,
  useKeyForRepo: ssh.useKeyForRepo,
  clearRepoKey: ssh.clearRepoKey,
  /** Whether the server would answer with nobody at the computer, as during a timed publish. */
  checkUnattended: (repo: string, remote: string) => withoutPrompts(() => ssh.checkRemote(repo, remote)),

  checkDependencies: (repo: string, rev?: string): Promise<DependencyReport> =>
    dependencies.checkDependencies(repo, { rev, cacheDir: dependencyCache(), sources: dependencySources() }),
  lastDependencyReport: (repo: string): Promise<DependencyReport | null> => dependencies.lastDependencyReport(repo, dependencyCache()),
  fixCommands: async (_repo: string, fix: DependencyFix): Promise<string[][]> => depsFix.fixCommands(fix),
  fixDependencies: depsFix.fixDependencies,

  previewRewrite: rewrite.previewRewrite,
  applyRewrite: rewrite.applyRewrite,
  undoEntry: rewrite.undoEntry,
  redoEntry: rewrite.redoEntry,
  purgeBackups: rewrite.purgeBackups,
  rewrittenTagsOnRemote: rewrite.rewrittenTagsOnRemote,
  signingSetup: rewrite.signingSetup,
  rebaseRange: rewrite.rebaseRange,

  schedulePublish: schedule.schedulePublish,
  publishNow: (repo: string, id: string) => schedule.publishNow(repo, id),
  cancelSchedule: schedule.cancelSchedule,
  dismissSchedule: schedule.dismissSchedule
}

type Api = typeof api
export type ApiMethod = keyof Api

type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never

/** The interface side of the bridge: the same methods, with the repository bound. */
export type RepoClient = {
  [K in ApiMethod]: (...args: Tail<Parameters<Api[K]>>) => Promise<Awaited<ReturnType<Api[K]>>>
}

export interface AppApi {
  recentRepos(): Promise<string[]>
  pickRepository(): Promise<string | null>
  openRepository(path: string): Promise<string>
  forgetRepository(path: string): Promise<void>
  pickFolder(): Promise<string | null>
  cloneRepository(url: string, parent: string, directory: string, keyPath?: string): Promise<string>
  initRepository(path: string): Promise<string>
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  sshListKeys(host?: string): Promise<ssh.SshKey[]>
  sshProbeHost(target: SshTarget): Promise<ssh.HostProbe>
  sshCheckKey(key: ssh.SshKey, target: SshTarget, interactive?: boolean): Promise<ssh.KeyStatus>
  sshDerivePublicKey(path: string): Promise<void>
  sshCreateKey(passphrase: string, remember: boolean): Promise<string>
  sshCheckRemote(repo: string | null, url: string, keyPath?: string): Promise<ssh.RemoteCheck>
  answerPrompt(id: string, reply: PromptReply | null): Promise<void>
  savedPassphrases(): Promise<{ available: boolean; count: number }>
  forgetPassphrases(): Promise<void>
  preferences(): Promise<{ language: Language; theme: Theme }>
  /** The window reloads afterwards, so every text is drawn again in the new language. */
  setLanguage(language: Language): Promise<void>
  setTheme(theme: Theme): Promise<void>
  autostart(): Promise<{ available: boolean; enabled: boolean }>
  setAutostart(enabled: boolean): Promise<void>
  checkForUpdates(): Promise<UpdateInfo>
  updateChecksEnabled(): Promise<boolean>
  setUpdateChecksEnabled(enabled: boolean): Promise<void>
  /** Whether the person agreed to send package names and versions to public databases. */
  dependencyConsent(): Promise<boolean>
  setDependencyConsent(agreed: boolean): Promise<void>
}

export interface ChronicleBridge {
  platform: string
  language: string
  call(method: string, ...args: unknown[]): Promise<unknown>
  app(method: string, ...args: unknown[]): Promise<unknown>
  onChanged(listener: (repo: string) => void): () => void
  onPrompt(listener: (prompt: AccessPrompt) => void): () => void
  onPromptClosed(listener: (id: string) => void): () => void
}
