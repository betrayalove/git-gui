import type {
  ForgeAccount,
  ForgeBranchInfo,
  ForgeContext,
  ForgeKind,
  ForgeRenamePreview,
  ForgeRenameResult,
  ForgeRepoSummary,
  ForgeRequest
} from '../shared/types'
import { git, gitLine, runGit } from './git'
import { forcePush, lsRemoteBranch, validateBranchName, type ForcePushRequest } from './ops'
import { readRefs, readRemotes } from './read'

export interface ResolvedAccount {
  account: ForgeAccount
  token: string
}

let findAccount: (host: string) => ResolvedAccount | null = () => null

/** The main process supplies accounts. Tests supply their own. */
export function configureForge(options: { findAccount: (host: string) => ResolvedAccount | null }): void {
  findAccount = options.findAccount
}

export interface ParsedRemote {
  host: string
  path: string
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url)
  if (scp && !/^[a-zA-Z]:[\\/]/.test(url)) return { host: scp[1].toLowerCase(), path: scp[2] }
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return null
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
    if (!path.includes('/')) return null
    // The SSH port differs from the web port, so it is not part of the host identity.
    const host = parsed.protocol === 'ssh:' ? parsed.hostname : parsed.host
    return { host: host.toLowerCase(), path }
  } catch {
    return null
  }
}

export function apiUrlFor(kind: ForgeKind, host: string): string {
  const scheme = isLoopback(host) ? 'http' : 'https'
  if (kind === 'github') return host === 'github.com' ? 'https://api.github.com' : `${scheme}://${host}/api/v3`
  return `${scheme}://${host}/api/v4`
}

function isLoopback(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
}

export function kindForHost(host: string, account: ForgeAccount | null): ForgeKind | null {
  if (account) return account.kind
  if (host === 'github.com') return 'github'
  if (host === 'gitlab.com') return 'gitlab'
  return null
}

export class ForgeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ForgeError'
  }
}

const TIMEOUT_MS = 20_000

/** Calls a forge API. Redirects are followed only within the same origin, so tokens cannot leak. */
export async function forgeFetch(
  account: Pick<ForgeAccount, 'kind' | 'apiUrl'>,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const headers: Record<string, string> = account.kind === 'github'
    ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    : { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
  headers['User-Agent'] = 'Chronicle'
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const origin = new URL(account.apiUrl).origin
  let url = `${account.apiUrl}${path}`
  for (let hop = 0; hop < 4; hop++) {
    let response: Response
    try {
      response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      throw new ForgeError(`Сервер ${new URL(url).host} недоступен: ${(error as Error).message}`, 0)
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      const next = new URL(response.headers.get('location')!, url)
      if (next.origin !== origin) throw new ForgeError(`Сервер перенаправляет на другой адрес: ${next.origin}`, response.status)
      url = next.href
      continue
    }
    const text = await response.text()
    if (!response.ok) throw new ForgeError(forgeErrorText(response.status, text), response.status)
    return text ? JSON.parse(text) : null
  }
  throw new ForgeError('Слишком много перенаправлений', 310)
}

function forgeErrorText(status: number, body: string): string {
  let detail = ''
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown }
    const value = parsed.message ?? parsed.error
    detail = typeof value === 'string' ? value : value ? JSON.stringify(value) : ''
  } catch {
    detail = ''
  }
  if (status === 401) return 'Токен не подошёл. Проверь его или подключи аккаунт заново.'
  if (status === 403) return `Нет прав на это действие${detail ? `: ${detail}` : ''}`
  if (status === 404) return `Не найдено на сервере. Возможно, у токена нет доступа${detail ? `: ${detail}` : ''}`
  return `Ошибка сервера ${status}${detail ? `: ${detail}` : ''}`
}

export async function fetchUsername(account: Pick<ForgeAccount, 'kind' | 'apiUrl'>, token: string): Promise<string> {
  const user = (await forgeFetch(account, token, '/user')) as { login?: string; username?: string }
  const name = user.login ?? user.username
  if (!name) throw new Error('Сервер не вернул имя пользователя')
  return name
}

interface GitHubPull {
  number: number
  title: string
  html_url: string
  user?: { login?: string }
  head: { ref: string; repo?: { full_name?: string } | null }
  base: { ref: string }
  draft?: boolean
  updated_at: string
}

interface GitLabMergeRequest {
  iid: number
  title: string
  web_url: string
  author?: { username?: string }
  source_branch: string
  target_branch: string
  draft?: boolean
  updated_at: string
}

function fromGitHub(pull: GitHubPull): ForgeRequest {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? '',
    sourceBranch: pull.head.ref,
    targetBranch: pull.base.ref,
    draft: pull.draft ?? false,
    updatedAt: pull.updated_at
  }
}

function fromGitLab(request: GitLabMergeRequest): ForgeRequest {
  return {
    number: request.iid,
    title: request.title,
    url: request.web_url,
    author: request.author?.username ?? '',
    sourceBranch: request.source_branch,
    targetBranch: request.target_branch,
    draft: request.draft ?? false,
    updatedAt: request.updated_at
  }
}

const PAGE_SIZE = 100
const MAX_PAGES = 10

/** The repository-bound API. One implementation per forge. */
abstract class ForgeClient {
  constructor(
    protected readonly account: ForgeAccount,
    protected readonly token: string,
    protected readonly path: string
  ) {}

  protected call(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    return forgeFetch(this.account, this.token, path, init)
  }

  protected async allPages<T>(path: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?'
    const items: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = (await this.call(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`)) as T[]
      items.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return items
  }

  abstract defaultBranch(): Promise<string>
  abstract setDefaultBranch(branch: string): Promise<void>
  abstract branchInfo(branch: string): Promise<ForgeBranchInfo>
  abstract listRequests(): Promise<ForgeRequest[]>
  abstract createRequest(request: NewForgeRequest): Promise<ForgeRequest>
  abstract renamePreview(branch: string): Promise<ForgeRenamePreview>
  abstract renameBranch(oldName: string, newName: string, sha: string): Promise<ForgeRenameResult>
  /** Null when this forge has no safe way to change this one setting. */
  abstract setForcePushAllowed(branch: string, allowed: boolean): Promise<void> | null
}

export interface NewForgeRequest {
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  draft: boolean
}

class GitHubClient extends ForgeClient {
  private get base(): string {
    return `/repos/${this.path.split('/').map(encodeURIComponent).join('/')}`
  }

  async defaultBranch(): Promise<string> {
    return ((await this.call(this.base)) as { default_branch: string }).default_branch
  }

  async setDefaultBranch(branch: string): Promise<void> {
    await this.call(this.base, { method: 'PATCH', body: { default_branch: branch } })
  }

  async branchInfo(branch: string): Promise<ForgeBranchInfo> {
    const name = encodeURIComponent(branch)
    const settingsUrl = `https://${this.account.host}/${this.path}/settings/branches`
    const data = (await this.call(`${this.base}/branches/${name}`)) as { protected?: boolean }
    let forcePushAllowed: boolean | null = true
    // Rulesets are readable with ordinary access, unlike classic protection settings.
    const rules = (await this.call(`${this.base}/rules/branches/${name}`).catch(() => [])) as { type?: string }[]
    if (rules.some((rule) => rule.type === 'non_fast_forward')) forcePushAllowed = false
    let isProtected = Boolean(data.protected) || rules.length > 0
    if (data.protected && forcePushAllowed) {
      try {
        const protection = (await this.call(`${this.base}/branches/${name}/protection`)) as { allow_force_pushes?: { enabled?: boolean } }
        forcePushAllowed = protection.allow_force_pushes?.enabled ?? false
      } catch (error) {
        if ((error as ForgeError).status === 404) isProtected = rules.length > 0
        else forcePushAllowed = null
      }
    }
    return { protected: isProtected, forcePushAllowed, settingsUrl }
  }

  async listRequests(): Promise<ForgeRequest[]> {
    return (await this.allPages<GitHubPull>(`${this.base}/pulls?state=open`)).map(fromGitHub)
  }

  async createRequest(request: NewForgeRequest): Promise<ForgeRequest> {
    return fromGitHub((await this.call(`${this.base}/pulls`, {
      method: 'POST',
      body: {
        title: request.title,
        body: request.description,
        head: request.sourceBranch,
        base: request.targetBranch,
        draft: request.draft
      }
    })) as GitHubPull)
  }

  async renamePreview(branch: string): Promise<ForgeRenamePreview> {
    const [requests, defaultBranch, info] = await Promise.all([this.listRequests(), this.defaultBranch(), this.branchInfo(branch)])
    return {
      isDefault: defaultBranch === branch,
      protected: info.protected,
      following: requests.filter((request) => request.sourceBranch === branch || request.targetBranch === branch),
      stranded: [],
      note: 'GitHub переименует ветку сам: Pull Request, защита и основная ветка перейдут на новое имя, а старое имя будет перенаправляться.'
    }
  }

  /** GitHub takes the whole protection object at once, so one wrong field could weaken it. */
  setForcePushAllowed(): null {
    return null
  }

  async renameBranch(oldName: string, newName: string): Promise<ForgeRenameResult> {
    const moved = (await this.renamePreview(oldName)).following.length
    await this.call(`${this.base}/branches/${encodeURIComponent(oldName)}/rename`, { method: 'POST', body: { new_name: newName } })
    return { oldBranchDeleted: true, movedRequests: moved, warnings: [] }
  }
}

class GitLabClient extends ForgeClient {
  private get base(): string {
    return `/projects/${encodeURIComponent(this.path)}`
  }

  async defaultBranch(): Promise<string> {
    return ((await this.call(this.base)) as { default_branch: string }).default_branch
  }

  async setDefaultBranch(branch: string): Promise<void> {
    await this.call(this.base, { method: 'PUT', body: { default_branch: branch } })
  }

  private async protection(branch: string): Promise<GitLabProtection | null> {
    try {
      return (await this.call(`${this.base}/protected_branches/${encodeURIComponent(branch)}`)) as GitLabProtection
    } catch (error) {
      if ((error as ForgeError).status === 404) return null
      throw error
    }
  }

  async branchInfo(branch: string): Promise<ForgeBranchInfo> {
    const settingsUrl = `https://${this.account.host}/${this.path}/-/settings/repository`
    const protection = await this.protection(branch)
    return {
      protected: Boolean(protection),
      forcePushAllowed: protection ? Boolean(protection.allow_force_push) : true,
      settingsUrl
    }
  }

  private async rawRequests(): Promise<GitLabMergeRequest[]> {
    return this.allPages<GitLabMergeRequest>(`${this.base}/merge_requests?state=opened`)
  }

  async listRequests(): Promise<ForgeRequest[]> {
    return (await this.rawRequests()).map(fromGitLab)
  }

  async createRequest(request: NewForgeRequest): Promise<ForgeRequest> {
    return fromGitLab((await this.call(`${this.base}/merge_requests`, {
      method: 'POST',
      body: {
        title: request.draft ? `Draft: ${request.title}` : request.title,
        description: request.description,
        source_branch: request.sourceBranch,
        target_branch: request.targetBranch
      }
    })) as GitLabMergeRequest)
  }

  async renamePreview(branch: string): Promise<ForgeRenamePreview> {
    const [requests, defaultBranch, protection] = await Promise.all([this.listRequests(), this.defaultBranch(), this.protection(branch)])
    return {
      isDefault: defaultBranch === branch,
      protected: Boolean(protection),
      following: requests.filter((request) => request.targetBranch === branch),
      stranded: requests.filter((request) => request.sourceBranch === branch),
      note: 'В GitLab нет переименования веток, поэтому создаётся новая ветка, а настройки переносятся на неё. Старая удаляется в конце, если от неё не осталось Merge Request.'
    }
  }

  async setForcePushAllowed(branch: string, allowed: boolean): Promise<void> {
    await this.call(`${this.base}/protected_branches/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: { allow_force_push: allowed }
    })
  }

  /** GitLab has no rename, so it is done in steps. The old branch goes last, and only when nothing needs it. */
  async renameBranch(oldName: string, newName: string, sha: string): Promise<ForgeRenameResult> {
    const result: ForgeRenameResult = { oldBranchDeleted: false, movedRequests: 0, warnings: [] }
    const preview = await this.renamePreview(oldName)
    const protection = await this.protection(oldName)
    await this.call(`${this.base}/repository/branches?branch=${encodeURIComponent(newName)}&ref=${encodeURIComponent(sha)}`, { method: 'POST' })
    if (protection) {
      const levels = (list?: { access_level?: number }[]): number | undefined => list?.[0]?.access_level
      await this.call(`${this.base}/protected_branches`, {
        method: 'POST',
        body: {
          name: newName,
          push_access_level: levels(protection.push_access_levels),
          merge_access_level: levels(protection.merge_access_levels),
          allow_force_push: protection.allow_force_push ?? false
        }
      })
    }
    for (const request of preview.following) {
      await this.call(`${this.base}/merge_requests/${request.number}`, { method: 'PUT', body: { target_branch: newName } })
      result.movedRequests++
    }
    if (preview.isDefault) await this.setDefaultBranch(newName)
    if (preview.stranded.length) {
      const list = preview.stranded.map((request) => `!${request.number}`).join(', ')
      result.warnings.push(`Merge Request ${list} идут от старой ветки, а GitLab не умеет менять ветку-источник. Ветка ${oldName} оставлена, удали её после их закрытия.`)
      return result
    }
    if (protection) await this.call(`${this.base}/protected_branches/${encodeURIComponent(oldName)}`, { method: 'DELETE' })
    await this.call(`${this.base}/repository/branches/${encodeURIComponent(oldName)}`, { method: 'DELETE' })
    result.oldBranchDeleted = true
    return result
  }
}

interface GitLabProtection {
  allow_force_push?: boolean
  push_access_levels?: { access_level?: number }[]
  merge_access_levels?: { access_level?: number }[]
}

/** The stored URL, unlike `git remote -v`, is not affected by insteadOf rules. */
async function rawRemoteUrl(cwd: string, remote: string): Promise<string> {
  return gitLine(cwd, ['config', '--get', `remote.${remote}.url`])
}

async function pickRemote(cwd: string, remote?: string): Promise<string | null> {
  if (remote) return remote
  const remotes = await readRemotes(cwd)
  return remotes.find((entry) => entry.name === 'origin')?.name ?? remotes[0]?.name ?? null
}

/** What is known about the server behind a remote. Null for unknown hosts with no account. */
export async function forgeContext(cwd: string, remote?: string): Promise<ForgeContext | null> {
  const name = await pickRemote(cwd, remote)
  if (!name) return null
  const parsed = parseRemoteUrl(await rawRemoteUrl(cwd, name))
  if (!parsed) return null
  const resolved = findAccount(parsed.host)
  const kind = kindForHost(parsed.host, resolved?.account ?? null)
  if (!kind) return null
  return {
    kind,
    host: parsed.host,
    path: parsed.path,
    remote: name,
    webUrl: `${isLoopback(parsed.host) ? 'http' : 'https'}://${parsed.host}/${parsed.path}`,
    account: resolved ? { username: resolved.account.username } : null
  }
}

async function clientFor(cwd: string, remote?: string): Promise<{ client: ForgeClient; remote: string }> {
  const name = await pickRemote(cwd, remote)
  if (!name) throw new Error('В репозитории не настроен remote')
  const parsed = parseRemoteUrl(await rawRemoteUrl(cwd, name))
  if (!parsed) throw new Error('Не удалось определить сервер по адресу remote')
  const resolved = findAccount(parsed.host)
  if (!resolved) throw new Error(`Для ${parsed.host} не подключён аккаунт`)
  const Client = resolved.account.kind === 'github' ? GitHubClient : GitLabClient
  return { client: new Client(resolved.account, resolved.token, parsed.path), remote: name }
}

export async function forgeBranchInfo(cwd: string, branch: string, remote?: string): Promise<ForgeBranchInfo> {
  return (await clientFor(cwd, remote)).client.branchInfo(branch)
}

export async function forgeListRequests(cwd: string, remote?: string): Promise<ForgeRequest[]> {
  return (await clientFor(cwd, remote)).client.listRequests()
}

export async function forgeCreateRequest(cwd: string, request: NewForgeRequest, remote?: string): Promise<ForgeRequest> {
  return (await clientFor(cwd, remote)).client.createRequest(request)
}

export async function forgeRenamePreview(cwd: string, branch: string, remote?: string): Promise<ForgeRenamePreview> {
  return (await clientFor(cwd, remote)).client.renamePreview(branch)
}

export async function forgeSetDefaultBranch(cwd: string, branch: string, remote?: string): Promise<void> {
  const { client, remote: name } = await clientFor(cwd, remote)
  await client.setDefaultBranch(branch)
  await git(cwd, ['remote', 'set-head', '--', name, branch])
}

/**
 * Force-pushes to a protected branch by allowing it just for this push. The protection is put
 * back whether the push worked or not, and a failure to put it back is reported, never hidden.
 */
export async function forcePushWithTemporaryAccess(
  cwd: string,
  request: ForcePushRequest,
  serverBranch: string
): Promise<{ restored: boolean }> {
  const { client, remote } = await clientFor(cwd, request.remote)
  const lifted = client.setForcePushAllowed(serverBranch, true)
  if (!lifted) throw new Error('Этот сервер не поддерживает временное снятие защиты')
  await lifted
  let pushError: Error | null = null
  try {
    await forcePush(cwd, { ...request, remote })
  } catch (error) {
    pushError = error as Error
  }
  let restored = true
  try {
    await client.setForcePushAllowed(serverBranch, false)
  } catch {
    restored = false
  }
  if (!restored) {
    const outcome = pushError ? `Отправка не удалась: ${pushError.message}` : 'Отправка прошла.'
    throw new Error(`${outcome} Защиту ветки ${serverBranch} вернуть не удалось: force-push на неё сейчас разрешён. Запрети его в настройках репозитория.`)
  }
  if (pushError) throw pushError
  return { restored }
}

const RENAME_POLL_MS = 500
const RENAME_POLLS = 20

/** Renames a branch through the server's API, then brings local branches and tracking refs along. */
export async function forgeRenameBranch(
  cwd: string,
  options: { oldName: string; newName: string; remote?: string }
): Promise<ForgeRenameResult> {
  const { oldName, newName } = options
  await validateBranchName(cwd, newName)
  const { client, remote } = await clientFor(cwd, options.remote)
  const sha = await lsRemoteBranch(cwd, remote, oldName)
  if (!sha) throw new Error(`На сервере нет ветки ${oldName}`)
  if (await lsRemoteBranch(cwd, remote, newName)) throw new Error(`На сервере уже есть ветка ${newName}`)
  const refs = await readRefs(cwd)
  const tracking = refs.filter((ref) => ref.kind === 'branch' && ref.upstream === `${remote}/${oldName}`)
  if (tracking.some((ref) => ref.name === oldName) && refs.some((ref) => ref.kind === 'branch' && ref.name === newName)) {
    throw new Error(`Локальная ветка ${newName} уже существует`)
  }
  const wasDefault = (await client.defaultBranch()) === oldName

  const result = await client.renameBranch(oldName, newName, sha)

  // The server may finish a rename a moment after answering.
  for (let attempt = 0; attempt < RENAME_POLLS && !(await lsRemoteBranch(cwd, remote, newName)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, RENAME_POLL_MS))
  }
  try {
    await git(cwd, ['fetch', '--', remote, `+refs/heads/${newName}:refs/remotes/${remote}/${newName}`])
    for (const ref of tracking) {
      const localName = ref.name === oldName ? newName : ref.name
      if (localName !== ref.name) await git(cwd, ['branch', '-m', '--', ref.name, localName])
      await git(cwd, ['branch', `--set-upstream-to=${remote}/${newName}`, localName])
    }
    if (result.oldBranchDeleted) await runGit(cwd, ['update-ref', '-d', `refs/remotes/${remote}/${oldName}`])
    if (wasDefault) await git(cwd, ['remote', 'set-head', '--', remote, newName])
  } catch (error) {
    result.warnings.push(`На сервере ветка переименована, но локальную обновить не удалось: ${(error as Error).message}`)
  }
  return result
}

/** Repositories the account can reach, for cloning from a list. */
export async function listAccountRepos(account: ForgeAccount, token: string): Promise<ForgeRepoSummary[]> {
  if (account.kind === 'github') {
    const repos = (await forgeFetch(account, token, `/user/repos?per_page=${PAGE_SIZE}&sort=pushed`)) as {
      full_name: string; description: string | null; clone_url: string; html_url: string; private: boolean; pushed_at: string
    }[]
    return repos.map((repo) => ({
      path: repo.full_name,
      description: repo.description ?? '',
      cloneUrl: repo.clone_url,
      webUrl: repo.html_url,
      private: repo.private,
      updatedAt: repo.pushed_at
    }))
  }
  const projects = (await forgeFetch(account, token, `/projects?membership=true&order_by=last_activity_at&per_page=${PAGE_SIZE}`)) as {
    path_with_namespace: string; description: string | null; http_url_to_repo: string; web_url: string; visibility: string; last_activity_at: string
  }[]
  return projects.map((project) => ({
    path: project.path_with_namespace,
    description: project.description ?? '',
    cloneUrl: project.http_url_to_repo,
    webUrl: project.web_url,
    private: project.visibility !== 'public',
    updatedAt: project.last_activity_at
  }))
}
