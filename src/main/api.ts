import * as forge from '../core/forge'
import * as ops from '../core/ops'
import * as read from '../core/read'
import * as rewrite from '../core/rewrite'
import * as schedule from '../core/schedule'
import type { ForgeAccount, ForgeContext, ForgeKind, ForgeRepoSummary, UpdateInfo, RepoStatus, RefInfo, RemoteInfo, StashEntry, JournalEntry, ScheduledPublish } from '../shared/types'

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
    const [status, refs, remotes, stashes, journal, schedules, forgeInfo] = await Promise.all([
      read.readStatus(repo),
      read.readRefs(repo),
      read.readRemotes(repo),
      read.readStashes(repo),
      rewrite.readJournal(repo),
      schedule.listSchedules(repo),
      forge.forgeContext(repo).catch(() => null)
    ])
    return { status, refs, remotes, stashes, journal, schedules, forge: forgeInfo }
  },
  readLog: read.readLog,
  commitDiff: read.commitDiff,
  stashDiff: read.stashDiff,
  worktreeDiff: read.worktreeDiff,
  readBlob: read.readBlob,

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

  previewRewrite: rewrite.previewRewrite,
  applyRewrite: rewrite.applyRewrite,
  undoEntry: rewrite.undoEntry,
  redoEntry: rewrite.redoEntry,
  purgeBackups: rewrite.purgeBackups,
  rewrittenTagsOnRemote: rewrite.rewrittenTagsOnRemote,
  signingSetup: rewrite.signingSetup,

  forgeBranchInfo: forge.forgeBranchInfo,
  forgeListRequests: forge.forgeListRequests,
  forgeCreateRequest: forge.forgeCreateRequest,
  forgeRenamePreview: forge.forgeRenamePreview,
  forgeRenameBranch: forge.forgeRenameBranch,
  forgeSetDefaultBranch: forge.forgeSetDefaultBranch,
  forcePushWithTemporaryAccess: forge.forcePushWithTemporaryAccess,

  schedulePublish: schedule.schedulePublish,
  publishNow: (repo: string, id: string) => schedule.publishNow(repo, id),
  cancelSchedule: schedule.cancelSchedule,
  dismissSchedule: schedule.dismissSchedule
}

export type Api = typeof api
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
  cloneRepository(url: string, parent: string, directory: string): Promise<string>
  initRepository(path: string): Promise<string>
  copyText(text: string): Promise<void>
  openExternal(url: string): Promise<void>
  accounts(): Promise<ForgeAccount[]>
  addAccount(kind: ForgeKind, host: string, token: string): Promise<ForgeAccount>
  addAccountFromGitHubCli(): Promise<ForgeAccount>
  removeAccount(id: string): Promise<void>
  accountRepos(id: string): Promise<ForgeRepoSummary[]>
  autostart(): Promise<{ available: boolean; enabled: boolean }>
  setAutostart(enabled: boolean): Promise<void>
  checkForUpdates(): Promise<UpdateInfo>
  updateChecksEnabled(): Promise<boolean>
  setUpdateChecksEnabled(enabled: boolean): Promise<void>
}

export interface ChronicleBridge {
  platform: string
  call(method: string, ...args: unknown[]): Promise<unknown>
  app(method: string, ...args: unknown[]): Promise<unknown>
  onChanged(listener: (repo: string) => void): () => void
}
