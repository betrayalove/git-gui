import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobContent, Commit, ConflictResolution, PushPreview, RenameBranchResult } from '../shared/types'
import { git, gitLine, revParse, runGit } from './git'
import { readCommits, readRefs, readRemotes } from './read'

export async function validateBranchName(cwd: string, name: string): Promise<void> {
  const { code } = await runGit(cwd, ['check-ref-format', '--branch', name], { okCodes: [1, 128] })
  if (code !== 0) throw new Error(`Недопустимое имя ветки: ${name}`)
}

// Working tree

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  await git(cwd, ['add', '--all', '--', ...paths])
}

export async function stageAll(cwd: string): Promise<void> {
  await git(cwd, ['add', '--all'])
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<void> {
  const unborn = !(await revParse(cwd, 'HEAD'))
  if (unborn) await git(cwd, ['rm', '--cached', '-r', '--quiet', '--', ...paths])
  else await git(cwd, ['restore', '--staged', '--', ...paths])
}

export async function discardFiles(cwd: string, tracked: string[], untracked: string[]): Promise<void> {
  if (tracked.length) await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked])
  if (untracked.length) await git(cwd, ['clean', '-f', '--', ...untracked])
}

export interface ApplyPatchOptions {
  /** Change the index instead of the working tree. */
  cached?: boolean
  reverse?: boolean
}

/** Stages, unstages or discards individual hunks, depending on the options. */
export async function applyPatch(cwd: string, patch: string, options: ApplyPatchOptions): Promise<void> {
  const args = ['apply', '--recount', '--whitespace=nowarn']
  if (options.cached) args.push('--cached')
  if (options.reverse) args.push('--reverse')
  await git(cwd, args, { input: patch })
}

export interface CommitOptions {
  message: string
  amend?: boolean
  allowEmpty?: boolean
}

export async function commit(cwd: string, options: CommitOptions): Promise<string> {
  const args = ['commit', '--file=-', '--cleanup=whitespace']
  if (options.amend) args.push('--amend')
  if (options.allowEmpty) args.push('--allow-empty')
  await git(cwd, args, { input: options.message })
  return gitLine(cwd, ['rev-parse', 'HEAD'])
}

// Branches

export async function checkout(cwd: string, name: string): Promise<void> {
  await git(cwd, ['switch', name])
}

export async function checkoutCommit(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['switch', '--detach', sha])
}

export async function checkoutRemoteBranch(cwd: string, remoteBranch: string): Promise<void> {
  const local = remoteBranch.split('/').slice(1).join('/')
  await validateBranchName(cwd, local)
  await git(cwd, ['switch', '--create', local, '--track', `refs/remotes/${remoteBranch}`])
}

export async function createBranch(cwd: string, name: string, startPoint: string, switchTo: boolean): Promise<void> {
  await validateBranchName(cwd, name)
  if (switchTo) await git(cwd, ['switch', '--create', name, startPoint])
  else await git(cwd, ['branch', '--', name, startPoint])
}

export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<void> {
  await git(cwd, ['branch', force ? '-D' : '-d', '--', name])
}

export async function mergeBranch(cwd: string, ref: string): Promise<void> {
  await git(cwd, ['merge', '--no-edit', ref])
}

export async function abortOperation(cwd: string, operation: string): Promise<void> {
  const commands: Record<string, string[]> = {
    merge: ['merge', '--abort'],
    rebase: ['rebase', '--abort'],
    'cherry-pick': ['cherry-pick', '--abort'],
    revert: ['revert', '--abort'],
    bisect: ['bisect', 'reset']
  }
  const args = commands[operation]
  if (!args) throw new Error(`Неизвестная операция: ${operation}`)
  await git(cwd, args)
}

export async function continueOperation(cwd: string, operation: string): Promise<void> {
  const commands: Record<string, string[]> = {
    merge: ['commit', '--no-edit'],
    rebase: ['rebase', '--continue'],
    'cherry-pick': ['cherry-pick', '--continue'],
    revert: ['revert', '--continue']
  }
  const args = commands[operation]
  if (!args) throw new Error(`Эту операцию нельзя продолжить: ${operation}`)
  await git(cwd, args)
}

export interface WorktreeConflict {
  path: string
  base?: string
  ours?: string
  theirs?: string
  mergedContent: BlobContent | null
}

export async function readWorktreeConflicts(cwd: string): Promise<WorktreeConflict[]> {
  const raw = await git(cwd, ['ls-files', '--unmerged', '-z'])
  const byPath = new Map<string, WorktreeConflict>()
  for (const entry of raw.split('\0')) {
    if (!entry) continue
    const tab = entry.indexOf('\t')
    const [, oid, stage] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    const conflict = byPath.get(path) ?? { path, mergedContent: null }
    if (stage === '1') conflict.base = oid
    else if (stage === '2') conflict.ours = oid
    else if (stage === '3') conflict.theirs = oid
    byPath.set(path, conflict)
  }
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  for (const conflict of byPath.values()) {
    try {
      const bytes = await readFile(join(root, conflict.path))
      conflict.mergedContent = {
        text: bytes.includes(0) ? '' : bytes.toString('utf8'),
        binary: bytes.includes(0),
        tooLarge: false
      }
    } catch {
      conflict.mergedContent = null
    }
  }
  return [...byPath.values()]
}

/** Marks a conflicted file as resolved. Only paths git reports as unmerged are accepted. */
export async function resolveWorktreeConflict(cwd: string, path: string, resolution: ConflictResolution): Promise<void> {
  const unmerged = await git(cwd, ['ls-files', '--unmerged', '-z', '--', path])
  if (!unmerged) throw new Error(`Файл не в конфликте: ${path}`)
  const root = await gitLine(cwd, ['rev-parse', '--show-toplevel'])
  if ('deleted' in resolution) {
    await git(root, ['rm', '--quiet', '--force', '--', path])
    return
  }
  const bytes = 'content' in resolution
    ? Buffer.from(resolution.content, 'utf8')
    : (await runGit(cwd, ['cat-file', 'blob', resolution.blob])).stdout
  await writeFile(join(root, path), bytes)
  await git(root, ['add', '--', path])
}

export async function cherryPick(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['cherry-pick', sha])
}

export async function revertCommit(cwd: string, sha: string): Promise<void> {
  await git(cwd, ['revert', '--no-edit', sha])
}

export async function resetTo(cwd: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
  await git(cwd, ['reset', `--${mode}`, sha])
}

// Tags

export async function createTag(cwd: string, name: string, sha: string, message?: string): Promise<void> {
  const { code } = await runGit(cwd, ['check-ref-format', `refs/tags/${name}`], { okCodes: [1] })
  if (code !== 0 || name.startsWith('-')) throw new Error(`Недопустимое имя тега: ${name}`)
  if (message) await git(cwd, ['tag', '--annotate', '--file=-', name, sha], { input: message })
  else await git(cwd, ['tag', name, sha])
}

export async function deleteTag(cwd: string, name: string, remote?: string): Promise<void> {
  if (remote) await git(cwd, ['push', remote, `:refs/tags/${name}`])
  await git(cwd, ['tag', '--delete', name])
}

// Stash

export async function stashPush(cwd: string, message: string, includeUntracked: boolean): Promise<void> {
  const args = ['stash', 'push']
  if (includeUntracked) args.push('--include-untracked')
  if (message) args.push('--message', message)
  await git(cwd, args)
}

export async function stashApply(cwd: string, index: number, pop: boolean): Promise<void> {
  await git(cwd, ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`])
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await git(cwd, ['stash', 'drop', `stash@{${index}}`])
}

export async function stashClear(cwd: string): Promise<void> {
  await git(cwd, ['stash', 'clear'])
}

export async function stashToBranch(cwd: string, name: string, index: number): Promise<void> {
  await validateBranchName(cwd, name)
  await git(cwd, ['stash', 'branch', name, `stash@{${index}}`])
}

// Remotes

export async function fetchAll(cwd: string): Promise<void> {
  await git(cwd, ['fetch', '--all', '--prune', '--tags'])
}

export async function pull(cwd: string, mode: 'ff-only' | 'rebase' | 'merge'): Promise<void> {
  const flag = mode === 'ff-only' ? '--ff-only' : mode === 'rebase' ? '--rebase' : '--no-rebase'
  await git(cwd, ['pull', flag])
}

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await git(cwd, ['remote', 'add', '--', name, url])
}

export async function removeRemote(cwd: string, name: string): Promise<void> {
  await git(cwd, ['remote', 'remove', '--', name])
}

export async function cloneRepository(url: string, parentDir: string, directory: string): Promise<string> {
  // Excludes transports such as ext::, which run commands named in the URL.
  await git(parentDir, ['clone', '--', url, directory], { env: { GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file' } })
  return gitLine(`${parentDir}/${directory}`, ['rev-parse', '--show-toplevel'])
}

export async function initRepository(path: string): Promise<void> {
  await git(path, ['init', '-b', 'main'])
}

export interface BranchTarget {
  remote: string
  remoteBranch: string
  localSha: string
}

export async function resolveBranchTarget(cwd: string, branch: string, remote?: string): Promise<BranchTarget> {
  const refs = await readRefs(cwd)
  const local = refs.find((ref) => ref.kind === 'branch' && ref.name === branch)
  if (!local) throw new Error(`Ветка не найдена: ${branch}`)
  if (local.upstream && (!remote || local.upstream.startsWith(`${remote}/`))) {
    const [upstreamRemote, ...rest] = local.upstream.split('/')
    const remotes = await readRemotes(cwd)
    const match = remotes
      .map((entry) => entry.name)
      .filter((name) => local.upstream === name || local.upstream!.startsWith(`${name}/`))
      .sort((a, b) => b.length - a.length)[0]
    const name = match ?? upstreamRemote
    return {
      remote: name,
      remoteBranch: match ? local.upstream.slice(match.length + 1) : rest.join('/'),
      localSha: local.sha
    }
  }
  const remotes = await readRemotes(cwd)
  const name = remote ?? remotes.find((entry) => entry.name === 'origin')?.name ?? remotes[0]?.name
  if (!name) throw new Error('В репозитории не настроен remote')
  return { remote: name, remoteBranch: branch, localSha: local.sha }
}

export async function lsRemoteBranch(cwd: string, remote: string, branch: string): Promise<string | null> {
  const raw = await git(cwd, ['ls-remote', '--', remote, `refs/heads/${branch}`])
  const line = raw.split('\n').find((entry) => entry.endsWith(`\trefs/heads/${branch}`))
  return line ? line.split('\t')[0] : null
}

export async function remoteDefaultBranch(cwd: string, remote: string): Promise<string | null> {
  const raw = await git(cwd, ['ls-remote', '--symref', '--', remote, 'HEAD'])
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(raw)?.[1] ?? null
}

/** Plain push. Refused by the server when it is not a fast-forward. */
export async function push(cwd: string, branch: string, remote?: string): Promise<void> {
  const target = await resolveBranchTarget(cwd, branch, remote)
  await git(cwd, [
    'push', '--set-upstream', '--', target.remote, `refs/heads/${branch}:refs/heads/${target.remoteBranch}`
  ])
}

async function commitsBetween(cwd: string, exclude: string | null, include: string | null): Promise<Commit[]> {
  if (!include) return []
  return readCommits(cwd, exclude ? [`${exclude}..${include}`] : [include])
}

export async function pushPreview(cwd: string, branch: string, remote?: string): Promise<PushPreview> {
  const target = await resolveBranchTarget(cwd, branch, remote)
  const remoteSha = await lsRemoteBranch(cwd, target.remote, target.remoteBranch)
  const trackedSha = await revParse(cwd, `refs/remotes/${target.remote}/${target.remoteBranch}`)
  const remoteMoved = remoteSha !== trackedSha
  // The server's commit may be unknown locally; fetching it makes the comparison truthful.
  if (remoteMoved && remoteSha) {
    await git(cwd, ['fetch', '--', target.remote, `+refs/heads/${target.remoteBranch}:refs/remotes/${target.remote}/${target.remoteBranch}`])
  }
  const comparison = remoteSha
  const appear = await commitsBetween(cwd, comparison, target.localSha)
  const vanish = comparison ? await commitsBetween(cwd, target.localSha, comparison) : []
  const defaultBranch = await remoteDefaultBranch(cwd, target.remote)
  return {
    branch,
    remote: target.remote,
    remoteBranch: target.remoteBranch,
    remoteSha,
    trackedSha,
    localSha: target.localSha,
    appear,
    vanish,
    remoteMoved,
    isDefaultBranch: defaultBranch === target.remoteBranch,
    needsForce: vanish.length > 0
  }
}

export interface ForcePushRequest {
  branch: string
  /** The server value the user saw in the preview. The push fails if the server has since moved. */
  expectedRemoteSha: string | null
  remote?: string
  tags?: { name: string; expected: string | null }[]
}

export async function forcePush(cwd: string, request: ForcePushRequest): Promise<void> {
  const target = await resolveBranchTarget(cwd, request.branch, request.remote)
  const remoteRef = `refs/heads/${target.remoteBranch}`
  const args = [
    'push', '--atomic', '--set-upstream',
    `--force-with-lease=${remoteRef}:${request.expectedRemoteSha ?? ''}`
  ]
  const refspecs = [`refs/heads/${request.branch}:${remoteRef}`]
  for (const tag of request.tags ?? []) {
    args.push(`--force-with-lease=refs/tags/${tag.name}:${tag.expected ?? ''}`)
    refspecs.push(`refs/tags/${tag.name}:refs/tags/${tag.name}`)
  }
  await git(cwd, [...args, '--', target.remote, ...refspecs])
}

export interface RenameBranchOptions {
  oldName: string
  newName: string
  /** Also rename the branch on the upstream remote. */
  renameOnRemote: boolean
}

export async function renameBranch(cwd: string, options: RenameBranchOptions): Promise<RenameBranchResult> {
  const { oldName, newName, renameOnRemote } = options
  await validateBranchName(cwd, newName)
  const result: RenameBranchResult = { localRenamed: false, remoteCreated: false, remoteDeleted: false, warnings: [] }
  const refs = await readRefs(cwd)
  const local = refs.find((ref) => ref.kind === 'branch' && ref.name === oldName)
  if (!local) throw new Error(`Ветка не найдена: ${oldName}`)
  if (refs.some((ref) => ref.kind === 'branch' && ref.name === newName)) {
    throw new Error(`Ветка ${newName} уже существует`)
  }
  await git(cwd, ['branch', '-m', '--', oldName, newName])
  result.localRenamed = true
  if (!renameOnRemote || !local.upstream) return result

  const target = await resolveBranchTarget(cwd, newName)
  const remoteOld = target.remoteBranch
  try {
    const serverSha = await lsRemoteBranch(cwd, target.remote, remoteOld)
    if (!serverSha) {
      result.warnings.push(`На сервере ветки ${remoteOld} уже нет, поэтому переименована только локальная`)
      await git(cwd, ['branch', '--unset-upstream', newName])
      return result
    }
    if (await lsRemoteBranch(cwd, target.remote, newName)) {
      throw new Error(`На сервере уже есть ветка ${newName}`)
    }
    // Publish what the server has, not local work the user has not pushed yet.
    await git(cwd, ['fetch', '--', target.remote, `+refs/heads/${remoteOld}:refs/remotes/${target.remote}/${remoteOld}`])
    await git(cwd, ['push', '--', target.remote, `${serverSha}:refs/heads/${newName}`])
    result.remoteCreated = true
    await git(cwd, ['fetch', '--', target.remote, `+refs/heads/${newName}:refs/remotes/${target.remote}/${newName}`])
    await git(cwd, ['branch', `--set-upstream-to=${target.remote}/${newName}`, newName])
  } catch (error) {
    if (!result.remoteCreated) {
      await git(cwd, ['branch', '-m', '--', newName, oldName])
      result.localRenamed = false
    }
    throw error
  }
  try {
    const serverSha = await lsRemoteBranch(cwd, target.remote, remoteOld)
    await git(cwd, [
      'push', `--force-with-lease=refs/heads/${remoteOld}:${serverSha ?? ''}`, '--', target.remote, `:refs/heads/${remoteOld}`
    ])
    await runGit(cwd, ['update-ref', '-d', `refs/remotes/${target.remote}/${remoteOld}`])
    result.remoteDeleted = true
  } catch (error) {
    const defaultBranch = await remoteDefaultBranch(cwd, target.remote).catch(() => null)
    result.warnings.push(
      defaultBranch === remoteOld
        ? `Ветка ${remoteOld} основная на сервере. Смени основную ветку в настройках репозитория, затем удали старую.`
        : `Ветка ${newName} создана, но ${remoteOld} удалить не удалось: ${(error as Error).message}`
    )
  }
  return result
}

/** Renames a branch that exists only on the remote. */
export async function renameRemoteBranch(cwd: string, remote: string, oldName: string, newName: string): Promise<void> {
  await validateBranchName(cwd, newName)
  const serverSha = await lsRemoteBranch(cwd, remote, oldName)
  if (!serverSha) throw new Error(`На сервере нет ветки ${oldName}`)
  if (await lsRemoteBranch(cwd, remote, newName)) throw new Error(`На сервере уже есть ветка ${newName}`)
  await git(cwd, ['fetch', '--', remote, `+refs/heads/${oldName}:refs/remotes/${remote}/${oldName}`])
  await git(cwd, ['push', '--', remote, `${serverSha}:refs/heads/${newName}`])
  await git(cwd, ['push', `--force-with-lease=refs/heads/${oldName}:${serverSha}`, '--', remote, `:refs/heads/${oldName}`])
  await git(cwd, ['fetch', '--prune', '--', remote])
}

export async function deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<void> {
  const serverSha = await lsRemoteBranch(cwd, remote, branch)
  if (!serverSha) throw new Error(`На сервере нет ветки ${branch}`)
  await git(cwd, ['push', `--force-with-lease=refs/heads/${branch}:${serverSha}`, '--', remote, `:refs/heads/${branch}`])
  await runGit(cwd, ['update-ref', '-d', `refs/remotes/${remote}/${branch}`])
}

