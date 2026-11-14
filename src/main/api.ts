import { join } from 'node:path'
import { app } from 'electron'
import * as dependencies from '../core/dependencies'
import * as depsFix from '../core/deps-fix'
import * as forge from '../core/forge'
import * as forgeApi from '../core/forge-api'
import * as ops from '../core/ops'
import * as read from '../core/read'
import * as rewrite from '../core/rewrite'
import * as schedule from '../core/schedule'
import * as signing from '../core/signing'
import * as ssh from '../core/ssh'
import * as workspace from '../core/workspace'
import { withoutPrompts } from '../core/git'
import { forgeTokens } from './forge-tokens'
import { t } from '../shared/i18n'
import type { AccessPrompt, PromptReply, SshTarget } from '../shared/access'
import type { Language } from '../shared/i18n'
import type { DependencyFix, DependencyReport } from '../shared/deps'
import type { AutoFetchMinutes, ForgeAccount, ForgeContext, ForgeKind, ForgeRequest, NewForgeRequest, Theme, UpdateInfo, RepoStatus, RefInfo, RemoteInfo, StashEntry, JournalEntry, ScheduledPublish } from '../shared/types'

const dependencyCache = (): string => join(app.getPath('userData'), 'dependencies')
// Tests answer for all three public databases from one local server.
const dependencySources = (): dependencies.Sources | undefined => {
  const server = process.env.CHRONICLE_DEPS_SERVER
  return server ? { osv: server, depsDev: server, endOfLife: server } : undefined
}

/** The repository's server with the token saved for it; null when there is no token. */
async function forgeTarget(repo: string): Promise<{ context: ForgeContext; kind: ForgeKind; target: forgeApi.ForgeTarget | null }> {
  const context = await forge.forgeContext(repo)
  const kind = context && (context.kind ?? forgeTokens().kindFor(context.host))
  if (!context || !kind) throw new Error(t('Remote этого репозитория не на GitHub и не на GitLab'))
  const token = await forgeTokens().token(context.host)
  return { context, kind, target: token ? { kind, origin: new URL(context.webUrl).origin, path: context.path, token } : null }
}

export interface RepoSnapshot {
  status: RepoStatus
  refs: RefInfo[]
  remotes: RemoteInfo[]
  stashes: StashEntry[]
  journal: JournalEntry[]
  schedules: ScheduledPublish[]
  forge: ForgeContext | null
  /** When the repository last fetched, as an ISO date; null if it never did. */
  lastFetch: string | null
}

/** Everything the interface may call. The first argument is always the repository path. */
export const api = {
  snapshot: async (repo: string): Promise<RepoSnapshot> => {
    const remoteList = read.readRemotes(repo)
    const [status, refs, remotes, stashes, journal, schedules, forgeInfo, lastFetch] = await Promise.all([
      read.readStatus(repo),
      read.readRefs(repo),
      remoteList,
      read.readStashes(repo),
      rewrite.readJournal(repo),
      schedule.listSchedules(repo),
      remoteList.then((list) => forge.forgeContext(repo, undefined, list)).catch(() => null),
      read.lastFetchTime(repo)
    ])
    // A self-hosted server's name may not tell its kind; a token saved for it does.
    const known = forgeInfo && { ...forgeInfo, kind: forgeInfo.kind ?? forgeTokens().kindFor(forgeInfo.host) }
    return { status, refs, remotes, stashes, journal, schedules, forge: known, lastFetch }
  },
  /** A fetch nobody asked for must not open a password window, so it fails instead. */
  autoFetch: (repo: string) => withoutPrompts(() => ops.fetchAll(repo)),
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
  ignorePath: ops.ignorePath,
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

  /** Open requests on the server; null when there is no token for it yet. */
  listRequests: async (repo: string): Promise<ForgeRequest[] | null> => {
    const { target } = await forgeTarget(repo)
    return target ? forgeApi.listRequests(target) : null
  },
  createRequest: async (repo: string, input: NewForgeRequest): Promise<string> => {
    const { context, target } = await forgeTarget(repo)
    if (!target) throw new Error(t('Нет токена для {host}. Добавь его в настройках.', { host: context.host }))
    return forgeApi.createRequest(target, input)
  },
  checkoutRequest: async (repo: string, request: Pick<ForgeRequest, 'number' | 'sourceBranch' | 'fromFork'>): Promise<string> => {
    const { context, kind } = await forgeTarget(repo)
    return ops.checkoutRequest(repo, context.remote, { kind, number: request.number, sourceBranch: request.sourceBranch, fromFork: request.fromFork })
  },

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
  readSignature: signing.readSignature,
  readSigning: signing.readSigning,
  setSigning: signing.setSigning,
  listGpgKeys: signing.listGpgKeys,
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
  /** How often open repositories fetch by themselves; 0 turns it off. */
  autoFetchMinutes(): Promise<AutoFetchMinutes>
  setAutoFetchMinutes(minutes: AutoFetchMinutes): Promise<void>
  /** Saved GitHub and GitLab tokens, by server; the tokens themselves stay in the main process. */
  forgeAccounts(): Promise<ForgeAccount[]>
  /** Checks the token with the server, then keeps it encrypted. */
  addForgeToken(host: string, kind: ForgeKind, token: string): Promise<ForgeAccount>
  removeForgeToken(host: string): Promise<void>
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
