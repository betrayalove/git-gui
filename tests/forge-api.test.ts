import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createRequest, graphqlUrl, listRequests, restUrl, whoAmI, type ForgeTarget } from '../src/core/forge-api'

interface Seen {
  method: string
  url: string
  authorization?: string
  body: unknown
}

let server: Server
let seen: Seen[] = []
let reply: (request: Seen) => { status: number; body: unknown; headers?: Record<string, string> }

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : null
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const entry: Seen = { method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization, body }
      seen.push(entry)
      const answer = reply(entry)
      response.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.CHRONICLE_FORGE_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  delete process.env.CHRONICLE_FORGE_API
  server.close()
})

beforeEach(() => {
  seen = []
})

const github: ForgeTarget = { kind: 'github', origin: 'https://github.com', path: 'team/project', token: 'gh-token' }
const gitlab: ForgeTarget = { kind: 'gitlab', origin: 'https://gitlab.example.com', path: 'group/sub/project', token: 'gl-token' }

describe('API addresses', () => {
  it('uses the API host of github.com, /api/v3 on GitHub Enterprise and /api/v4 on GitLab', () => {
    const saved = process.env.CHRONICLE_FORGE_API
    delete process.env.CHRONICLE_FORGE_API
    try {
      expect(restUrl('github', 'https://github.com', '/user')).toBe('https://api.github.com/user')
      expect(graphqlUrl('github', 'https://github.com')).toBe('https://api.github.com/graphql')
      expect(restUrl('github', 'https://github.example.com', '/user')).toBe('https://github.example.com/api/v3/user')
      expect(graphqlUrl('github', 'https://github.example.com')).toBe('https://github.example.com/api/graphql')
      expect(restUrl('gitlab', 'http://gitlab.local:8080', '/user')).toBe('http://gitlab.local:8080/api/v4/user')
      expect(graphqlUrl('gitlab', 'https://gitlab.com')).toBe('https://gitlab.com/api/graphql')
    } finally {
      process.env.CHRONICLE_FORGE_API = saved
    }
  })
})

describe('GitHub', () => {
  it('names the owner of a token and sends it only as a header', async () => {
    reply = () => ({ status: 200, body: { login: 'mira' } })
    expect(await whoAmI('github', 'https://github.com', 'gh-token')).toBe('mira')
    expect(seen).toEqual([{ method: 'GET', url: '/github/user', authorization: 'Bearer gh-token', body: null }])
  })

  it('lists open pull requests with the state of their checks in one call', async () => {
    reply = () => ({
      status: 200,
      body: {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 12, title: 'Add search', url: 'https://github.com/team/project/pull/12', isDraft: false, updatedAt: '2026-11-10T10:00:00Z',
                  headRefName: 'search', baseRefName: 'main', isCrossRepository: false, author: { login: 'mira' },
                  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }
                },
                {
                  number: 9, title: 'Fix typo', url: 'https://github.com/team/project/pull/9', isDraft: true, updatedAt: '2026-11-09T10:00:00Z',
                  headRefName: 'patch-1', baseRefName: 'main', isCrossRepository: true, author: null,
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] }
                }
              ]
            }
          }
        }
      }
    })
    expect(await listRequests(github)).toEqual([
      { number: 12, title: 'Add search', url: 'https://github.com/team/project/pull/12', author: 'mira', sourceBranch: 'search', targetBranch: 'main', draft: false, checks: 'failure', updatedAt: '2026-11-10T10:00:00Z', fromFork: false },
      { number: 9, title: 'Fix typo', url: 'https://github.com/team/project/pull/9', author: '', sourceBranch: 'patch-1', targetBranch: 'main', draft: true, checks: 'none', updatedAt: '2026-11-09T10:00:00Z', fromFork: true }
    ])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/github/graphql', body: { variables: { owner: 'team', name: 'project' } } })
  })

  it('opens a pull request and returns its page', async () => {
    reply = () => ({ status: 201, body: { html_url: 'https://github.com/team/project/pull/13' } })
    const url = await createRequest(github, { sourceBranch: 'search', targetBranch: 'main', title: '  Add search ', description: 'Body', draft: true })
    expect(url).toBe('https://github.com/team/project/pull/13')
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/github/repos/team/project/pulls', body: { title: 'Add search', head: 'search', base: 'main', body: 'Body', draft: true } })
  })

  it('passes on why GitHub refused', async () => {
    reply = () => ({ status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for team:search.' }] } })
    await expect(createRequest(github, { sourceBranch: 'search', targetBranch: 'main', title: 'Again', description: '', draft: false }))
      .rejects.toThrow('github.com отказал: Validation Failed: A pull request already exists for team:search.')
  })

  it('explains a rejected token, missing rights and the rate limit in plain words', async () => {
    reply = () => ({ status: 401, body: { message: 'Bad credentials' } })
    await expect(whoAmI('github', 'https://github.com', 'bad')).rejects.toThrow('не подошёл или отозван')
    reply = () => ({ status: 403, body: { message: 'Resource not accessible' } })
    await expect(listRequests(github)).rejects.toThrow('не хватает прав')
    reply = () => ({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } })
    await expect(listRequests(github)).rejects.toThrow('ограничил число запросов')
    reply = () => ({ status: 200, body: { data: { repository: null }, errors: [{ message: 'Could not resolve to a Repository' }] } })
    await expect(listRequests(github)).rejects.toThrow('Репозиторий не найден на github.com')
  })
})

describe('GitLab', () => {
  it('lists open merge requests of a project in a subgroup', async () => {
    reply = () => ({
      status: 200,
      body: {
        data: {
          project: {
            mergeRequests: {
              nodes: [{
                iid: '5', title: 'Draft: Rework login', webUrl: 'https://gitlab.example.com/group/sub/project/-/merge_requests/5', draft: true,
                updatedAt: '2026-11-11T08:00:00Z', sourceBranch: 'login', targetBranch: 'main', sourceProjectId: 3, targetProjectId: 7,
                author: { username: 'mira' }, headPipeline: { status: 'RUNNING' }
              }]
            }
          }
        }
      }
    })
    expect(await listRequests(gitlab)).toEqual([{
      number: 5, title: 'Draft: Rework login', url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/5', author: 'mira',
      sourceBranch: 'login', targetBranch: 'main', draft: true, checks: 'pending', updatedAt: '2026-11-11T08:00:00Z', fromFork: true
    }])
    expect(seen[0]).toMatchObject({ url: '/gitlab/graphql', authorization: 'Bearer gl-token', body: { variables: { path: 'group/sub/project' } } })
  })

  it('opens a draft merge request through the title GitLab expects', async () => {
    reply = () => ({ status: 201, body: { web_url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/6' } })
    await createRequest(gitlab, { sourceBranch: 'login', targetBranch: 'main', title: 'Rework login', description: '', draft: true })
    expect(seen[0]).toMatchObject({
      url: '/gitlab/v4/projects/group%2Fsub%2Fproject/merge_requests',
      body: { source_branch: 'login', target_branch: 'main', title: 'Draft: Rework login' }
    })
  })

  it('names the owner of a token', async () => {
    reply = () => ({ status: 200, body: { username: 'mira' } })
    expect(await whoAmI('gitlab', 'https://gitlab.example.com', 'gl-token')).toBe('mira')
    expect(seen[0].url).toBe('/gitlab/v4/user')
  })
})
