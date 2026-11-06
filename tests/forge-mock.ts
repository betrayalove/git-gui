import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { git, gitLine } from '../src/core/git'

export interface MockRequest {
  id: number
  source: string
  target: string
  title: string
}

export interface MockState {
  kind: 'github' | 'gitlab'
  token: string
  /** Bare repository acting as the server's storage. */
  bare: string
  defaultBranch: string
  requests: MockRequest[]
  protections: Record<string, { allowForcePush: boolean }>
  rulesets: Record<string, string[]>
  log: string[]
  renameDelayMs?: number
  redirectTo?: string
  failProtectionRestore?: boolean
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** A small stand-in for the GitHub and GitLab APIs, backed by a real bare repository. */
export async function startMockForge(state: MockState): Promise<{ server: Server; host: string; apiUrl: string }> {
  const server = createServer((request, response) => {
    void handle(state, request, response).catch((error: Error) => send(response, 500, { message: error.message }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const host = `127.0.0.1:${port}`
  return { server, host, apiUrl: `http://${host}${state.kind === 'github' ? '/api/v3' : '/api/v4'}` }
}

async function handle(state: MockState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url!, 'http://mock')
  const method = request.method!
  state.log.push(`${method} ${url.pathname}${url.search}`)
  const authorized = state.kind === 'github'
    ? request.headers.authorization === `Bearer ${state.token}`
    : request.headers['private-token'] === state.token
  if (state.redirectTo && !url.pathname.endsWith('/final')) {
    send(response, 302, {}, { Location: state.redirectTo })
    return
  }
  if (!authorized) {
    send(response, 401, { message: 'Bad credentials' })
    return
  }
  const body = method === 'GET' ? {} : await bodyOf(request)
  const path = url.pathname.replace(/^\/api\/v[34]/, '')
  const segment = (value: string): string => decodeURIComponent(value)
  if (path === '/user') {
    send(response, 200, state.kind === 'github' ? { login: 'mock-user' } : { username: 'mock-user' })
  } else if (state.kind === 'github') {
    await github(state, method, path, body, response, segment)
  } else {
    await gitlab(state, method, path, url, body, response, segment)
  }
}

async function github(
  state: MockState, method: string, path: string, body: Record<string, unknown>,
  response: ServerResponse, segment: (value: string) => string
): Promise<void> {
  const pull = (item: MockRequest): unknown => ({
    number: item.id, title: item.title, html_url: `https://mock/pull/${item.id}`, user: { login: 'dev' },
    head: { ref: item.source }, base: { ref: item.target }, draft: false, updated_at: '2026-01-01T00:00:00Z'
  })
  let match: RegExpExecArray | null
  if ((match = /^\/repos\/[^/]+\/[^/]+$/.exec(path))) {
    if (method === 'PATCH') state.defaultBranch = String(body.default_branch)
    send(response, 200, { default_branch: state.defaultBranch })
  } else if ((match = /^\/repos\/[^/]+\/[^/]+\/pulls$/.exec(path))) {
    if (method === 'POST') {
      const item = { id: state.requests.length + 1, source: String(body.head), target: String(body.base), title: String(body.title) }
      state.requests.push(item)
      send(response, 201, pull(item))
    } else {
      send(response, 200, state.requests.map(pull))
    }
  } else if ((match = /^\/repos\/[^/]+\/[^/]+\/rules\/branches\/([^/]+)$/.exec(path))) {
    send(response, 200, (state.rulesets[segment(match[1])] ?? []).map((type) => ({ type })))
  } else if ((match = /^\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)\/protection$/.exec(path))) {
    const protection = state.protections[segment(match[1])]
    if (protection) send(response, 200, { allow_force_pushes: { enabled: protection.allowForcePush } })
    else send(response, 404, { message: 'Branch not protected' })
  } else if ((match = /^\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)\/rename$/.exec(path))) {
    const [from, to] = [segment(match[1]), String(body.new_name)]
    await git(state.bare, ['branch', '-m', from, to])
    for (const item of state.requests) {
      if (item.source === from) item.source = to
      if (item.target === from) item.target = to
    }
    if (state.defaultBranch === from) state.defaultBranch = to
    send(response, 201, { name: to })
  } else if ((match = /^\/repos\/[^/]+\/[^/]+\/branches\/([^/]+)$/.exec(path))) {
    send(response, 200, { protected: Boolean(state.protections[segment(match[1])]) })
  } else {
    send(response, 404, { message: `No route ${path}` })
  }
}

async function gitlab(
  state: MockState, method: string, path: string, url: URL, body: Record<string, unknown>,
  response: ServerResponse, segment: (value: string) => string
): Promise<void> {
  const request = (item: MockRequest): unknown => ({
    iid: item.id, title: item.title, web_url: `https://mock/-/merge_requests/${item.id}`, author: { username: 'dev' },
    source_branch: item.source, target_branch: item.target, draft: item.title.startsWith('Draft:'), updated_at: '2026-01-01T00:00:00Z'
  })
  let match: RegExpExecArray | null
  if ((match = /^\/projects\/[^/]+$/.exec(path))) {
    if (method === 'PUT') state.defaultBranch = String(body.default_branch)
    send(response, 200, { default_branch: state.defaultBranch })
  } else if ((match = /^\/projects\/[^/]+\/merge_requests$/.exec(path))) {
    if (method === 'POST') {
      const item = { id: state.requests.length + 1, source: String(body.source_branch), target: String(body.target_branch), title: String(body.title) }
      state.requests.push(item)
      send(response, 201, request(item))
    } else {
      send(response, 200, state.requests.map(request))
    }
  } else if ((match = /^\/projects\/[^/]+\/merge_requests\/(\d+)$/.exec(path))) {
    const item = state.requests.find((entry) => entry.id === Number(match![1]))!
    item.target = String(body.target_branch)
    send(response, 200, request(item))
  } else if ((match = /^\/projects\/[^/]+\/repository\/branches$/.exec(path))) {
    const [name, ref] = [url.searchParams.get('branch')!, url.searchParams.get('ref')!]
    await git(state.bare, ['branch', name, ref])
    send(response, 201, { name, commit: { id: await gitLine(state.bare, ['rev-parse', name]) } })
  } else if ((match = /^\/projects\/[^/]+\/repository\/branches\/([^/]+)$/.exec(path))) {
    const name = segment(match[1])
    if (state.protections[name] || state.defaultBranch === name) {
      send(response, 403, { message: 'Cannot delete protected or default branch' })
      return
    }
    await git(state.bare, ['branch', '-D', name])
    send(response, 204, null)
  } else if ((match = /^\/projects\/[^/]+\/protected_branches$/.exec(path))) {
    state.protections[String(body.name)] = { allowForcePush: Boolean(body.allow_force_push) }
    send(response, 201, { name: body.name })
  } else if ((match = /^\/projects\/[^/]+\/protected_branches\/([^/]+)$/.exec(path))) {
    const name = segment(match[1])
    if (method === 'DELETE') {
      delete state.protections[name]
      send(response, 204, null)
    } else if (method === 'PATCH') {
      if (state.failProtectionRestore && body.allow_force_push === false) {
        send(response, 500, { message: 'Internal error' })
        return
      }
      state.protections[name].allowForcePush = Boolean(body.allow_force_push)
      send(response, 200, { name })
    } else if (state.protections[name]) {
      send(response, 200, {
        name, allow_force_push: state.protections[name].allowForcePush,
        push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 40 }]
      })
    } else {
      send(response, 404, { message: 'Not found' })
    }
  } else {
    send(response, 404, { message: `No route ${path}` })
  }
}
