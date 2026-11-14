import type { CheckState, ForgeKind, ForgeRequest, NewForgeRequest } from '../shared/types'
import { t } from '../shared/i18n'

/** A repository on a server the person has a token for. */
export interface ForgeTarget {
  kind: ForgeKind
  /** The site's address, such as https://gitlab.example.com:8443. */
  origin: string
  /** `owner/name` on GitHub, `group/subgroup/name` on GitLab. */
  path: string
  token: string
}

const TIMEOUT_MS = 20_000

/**
 * Where the server's API lives. Tests point every server at one local stand-in through
 * CHRONICLE_FORGE_API, so a token never travels anywhere but the server it was made for.
 */
function apiRoot(kind: ForgeKind, origin: string): string {
  const override = process.env.CHRONICLE_FORGE_API
  if (override) return `${override.replace(/\/$/, '')}/${kind}`
  if (kind === 'github' && origin === 'https://github.com') return 'https://api.github.com'
  return `${origin}/api`
}

export function restUrl(kind: ForgeKind, origin: string, path: string): string {
  const root = apiRoot(kind, origin)
  if (kind === 'gitlab') return `${root}/v4${path}`
  // GitHub Enterprise serves REST under /api/v3; github.com has a host of its own for it.
  return root.endsWith('/api') ? `${root}/v3${path}` : `${root}${path}`
}

export function graphqlUrl(kind: ForgeKind, origin: string): string {
  return `${apiRoot(kind, origin)}/graphql`
}

const hostOf = (origin: string): string => new URL(origin).host

function headers(kind: ForgeKind, token: string): Record<string, string> {
  return {
    Accept: kind === 'github' ? 'application/vnd.github+json' : 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Chronicle'
  }
}

/** The server's own explanation, if its answer carries one. */
function serverMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const record = body as { message?: unknown; errors?: unknown; error?: unknown }
  const details = Array.isArray(record.errors)
    ? record.errors.map((item) => (typeof item === 'string' ? item : (item as { message?: string }).message)).filter(Boolean)
    : []
  const message = Array.isArray(record.message) ? record.message.join(', ') : record.message ?? record.error
  return [typeof message === 'string' ? message : null, ...details].filter(Boolean).join(': ') || null
}

async function call<T>(kind: ForgeKind, origin: string, token: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const host = hostOf(origin)
  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: headers(kind, token),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new Error(t('Нет связи с {host}. Проверь интернет и попробуй ещё раз.', { host }))
  }
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (response.status === 401) throw new Error(t('Токен для {host} не подошёл или отозван. Добавь новый в настройках.', { host }))
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new Error(t('{host} временно ограничил число запросов. Попробуй через несколько минут.', { host }))
  }
  if (response.status === 403) throw new Error(t('У токена для {host} не хватает прав. Нужен доступ к репозиториям: repo на GitHub или api на GitLab.', { host }))
  if (response.status === 404) throw new Error(t('Репозиторий не найден на {host}. Возможно, у токена нет к нему доступа.', { host }))
  if (!response.ok) {
    const reason = serverMessage(body) ?? `HTTP ${response.status}`
    throw new Error(t('{host} отказал: {reason}', { host, reason }))
  }
  // GraphQL reports problems inside a successful answer.
  const errors = (body as { errors?: { message?: string }[] } | null)?.errors
  if (Array.isArray(errors) && errors.length && !(body as { data?: unknown }).data) {
    throw new Error(t('{host} отказал: {reason}', { host, reason: errors.map((item) => item.message).join(', ') }))
  }
  return body as T
}

/** The account a token belongs to; also proves that the token works. */
export async function whoAmI(kind: ForgeKind, origin: string, token: string): Promise<string> {
  const user = await call<{ login?: string; username?: string }>(kind, origin, token, restUrl(kind, origin, '/user'))
  const name = kind === 'github' ? user.login : user.username
  if (!name) throw new Error(t('{host} не назвал владельца токена', { host: hostOf(origin) }))
  return name
}

const GITHUB_CHECKS: Record<string, CheckState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' }
const GITLAB_CHECKS: Record<string, CheckState> = {
  SUCCESS: 'success', FAILED: 'failure', CANCELED: 'failure',
  RUNNING: 'pending', PENDING: 'pending', CREATED: 'pending', PREPARING: 'pending', WAITING_FOR_RESOURCE: 'pending', SCHEDULED: 'pending', MANUAL: 'pending'
}

interface GithubPull {
  number: number
  title: string
  url: string
  isDraft: boolean
  updatedAt: string
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  author: { login: string } | null
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
}

interface GitlabMerge {
  iid: string
  title: string
  webUrl: string
  draft: boolean
  updatedAt: string
  sourceBranch: string
  targetBranch: string
  sourceProjectId: number | null
  targetProjectId: number
  author: { username: string } | null
  headPipeline: { status: string } | null
}

/** Open requests, most recently updated first, with the state of their CI checks. One API call. */
export async function listRequests(target: ForgeTarget): Promise<ForgeRequest[]> {
  const { kind, origin, token, path } = target
  const host = hostOf(origin)
  if (kind === 'github') {
    const [owner, name] = path.split('/')
    const query = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number title url isDraft updatedAt headRefName baseRefName isCrossRepository
            author { login }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          }
        }
      }
    }`
    const answer = await call<{ data: { repository: { pullRequests: { nodes: GithubPull[] } } | null } }>(
      kind, origin, token, graphqlUrl(kind, origin), { method: 'POST', body: { query, variables: { owner, name } } }
    )
    if (!answer.data.repository) throw new Error(t('Репозиторий не найден на {host}. Возможно, у токена нет к нему доступа.', { host }))
    return answer.data.repository.pullRequests.nodes.map((pull) => {
      const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup?.state
      return {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        author: pull.author?.login ?? '',
        sourceBranch: pull.headRefName,
        targetBranch: pull.baseRefName,
        draft: pull.isDraft,
        checks: rollup ? GITHUB_CHECKS[rollup] ?? 'none' : 'none',
        updatedAt: pull.updatedAt,
        fromFork: pull.isCrossRepository
      }
    })
  }
  const query = `query($path: ID!) {
    project(fullPath: $path) {
      mergeRequests(state: opened, sort: UPDATED_DESC, first: 50) {
        nodes {
          iid title webUrl draft updatedAt sourceBranch targetBranch sourceProjectId targetProjectId
          author { username }
          headPipeline { status }
        }
      }
    }
  }`
  const answer = await call<{ data: { project: { mergeRequests: { nodes: GitlabMerge[] } } | null } }>(
    kind, origin, token, graphqlUrl(kind, origin), { method: 'POST', body: { query, variables: { path } } }
  )
  if (!answer.data.project) throw new Error(t('Репозиторий не найден на {host}. Возможно, у токена нет к нему доступа.', { host }))
  return answer.data.project.mergeRequests.nodes.map((merge) => ({
    number: Number(merge.iid),
    title: merge.title,
    url: merge.webUrl,
    author: merge.author?.username ?? '',
    sourceBranch: merge.sourceBranch,
    targetBranch: merge.targetBranch,
    draft: merge.draft,
    checks: merge.headPipeline ? GITLAB_CHECKS[merge.headPipeline.status] ?? 'none' : 'none',
    updatedAt: merge.updatedAt,
    fromFork: merge.sourceProjectId !== merge.targetProjectId
  }))
}

/** Opens a request and returns its page on the site. */
export async function createRequest(target: ForgeTarget, input: NewForgeRequest): Promise<string> {
  const { kind, origin, token, path } = target
  const title = input.title.trim()
  if (!title) throw new Error(t('Нужен заголовок'))
  if (kind === 'github') {
    const created = await call<{ html_url: string }>(kind, origin, token, restUrl(kind, origin, `/repos/${path}/pulls`), {
      method: 'POST',
      body: { title, head: input.sourceBranch, base: input.targetBranch, body: input.description, draft: input.draft }
    })
    return created.html_url
  }
  const created = await call<{ web_url: string }>(kind, origin, token, restUrl(kind, origin, `/projects/${encodeURIComponent(path)}/merge_requests`), {
    method: 'POST',
    // GitLab marks a draft by the start of its title.
    body: { source_branch: input.sourceBranch, target_branch: input.targetBranch, title: input.draft ? `Draft: ${title}` : title, description: input.description }
  })
  return created.web_url
}

/** The ref a server keeps for every request, which also covers requests from forks. */
export function requestRef(kind: ForgeKind, number: number): string {
  return kind === 'github' ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`
}
