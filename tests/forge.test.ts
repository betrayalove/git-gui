import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apiUrlFor, configureForge, fetchUsername, forgeBranchInfo, forgeContext, forgeCreateRequest, forgeFetch, forgeListRequests,
  forgeRenameBranch, forgeRenamePreview, forgeSetDefaultBranch, parseRemoteUrl
} from '../src/core/forge'
import { credentialEnv, git, gitLine } from '../src/core/git'
import { readRefs, readRemotes } from '../src/core/read'
import type { ForgeKind } from '../src/shared/types'
import { addOrigin, commitFile, createRepo, head } from './helpers'
import { startMockForge, type MockState } from './forge-mock'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  configureForge({ findAccount: () => null })
})

async function setup(kind: ForgeKind, partial: Partial<MockState> = {}): Promise<{ dir: string; bare: string; state: MockState; host: string; apiUrl: string }> {
  const dir = await createRepo()
  await commitFile(dir, 'a.txt', '1\n', 'one')
  const bare = await addOrigin(dir)
  await git(dir, ['switch', '-c', 'feature'])
  await commitFile(dir, 'b.txt', '2\n', 'two')
  await git(dir, ['push', '-q', '--set-upstream', 'origin', 'feature'])
  await git(dir, ['switch', 'main'])
  const state: MockState = {
    kind, token: 'secret-token', bare, defaultBranch: 'main', requests: [], protections: {}, rulesets: {}, log: [], ...partial
  }
  const { server, host, apiUrl } = await startMockForge(state)
  servers.push(server)
  // git keeps talking to the bare repository while the stored URL names the mock forge.
  const webUrl = `http://${host}/team/project.git`
  await git(dir, ['config', '--unset-all', 'remote.origin.url'])
  await git(dir, ['config', 'remote.origin.url', webUrl])
  await git(dir, ['config', `url.${bare}.insteadOf`, webUrl])
  configureForge({
    findAccount: (candidate) => candidate === host
      ? { account: { id: '1', kind, host, apiUrl, username: 'mock-user' }, token: 'secret-token' }
      : null
  })
  return { dir, bare, state, host, apiUrl }
}

describe('parsing remote URLs', () => {
  it.each([
    ['git@github.com:owner/repo.git', 'github.com', 'owner/repo'],
    ['git@gitlab.com:group/sub/repo.git', 'gitlab.com', 'group/sub/repo'],
    ['https://github.com/owner/repo', 'github.com', 'owner/repo'],
    ['https://github.com/owner/repo.git/', 'github.com', 'owner/repo'],
    ['https://user@gitlab.example.com/group/sub/repo.git', 'gitlab.example.com', 'group/sub/repo'],
    ['ssh://git@gitlab.example.com:2222/group/repo.git', 'gitlab.example.com', 'group/repo'],
    ['https://GitHub.com/owner/repo', 'github.com', 'owner/repo'],
    ['http://127.0.0.1:8080/a/b.git', '127.0.0.1:8080', 'a/b']
  ])('reads %s', (url, host, path) => {
    expect(parseRemoteUrl(url)).toEqual({ host, path })
  })

  it.each(['/local/path/repo.git', 'C:\\Users\\me\\repo.git', 'file:///srv/repo.git', '../relative/repo', 'https://github.com/only-one'])(
    'rejects %s', (url) => { expect(parseRemoteUrl(url)).toBeNull() }
  )

  it('builds API addresses, with plain HTTP only for this computer', () => {
    expect(apiUrlFor('github', 'github.com')).toBe('https://api.github.com')
    expect(apiUrlFor('github', 'ghe.example.com')).toBe('https://ghe.example.com/api/v3')
    expect(apiUrlFor('gitlab', 'gitlab.com')).toBe('https://gitlab.com/api/v4')
    expect(apiUrlFor('gitlab', 'localhost:3000')).toBe('http://localhost:3000/api/v4')
  })
})

describe('context', () => {
  it('recognizes public hosts with no account, and local remotes as nothing', async () => {
    const dir = await createRepo()
    expect(await forgeContext(dir)).toBeNull()
    await git(dir, ['remote', 'add', 'origin', 'git@gitlab.com:team/app.git'])
    expect(await forgeContext(dir)).toMatchObject({ kind: 'gitlab', path: 'team/app', webUrl: 'https://gitlab.com/team/app', account: null })
    await git(dir, ['remote', 'set-url', 'origin', 'git@code.corp.example:team/app.git'])
    expect(await forgeContext(dir)).toBeNull()
  })

  it('recognizes a self-hosted server through its account', async () => {
    const { dir, host } = await setup('gitlab')
    expect(await forgeContext(dir)).toMatchObject({ kind: 'gitlab', host, path: 'team/project', account: { username: 'mock-user' } })
  })
})

describe('security', () => {
  it('sends the token only with the right header and reports a bad token plainly', async () => {
    const { apiUrl } = await setup('github')
    expect(await fetchUsername({ kind: 'github', apiUrl }, 'secret-token')).toBe('mock-user')
    const error = await fetchUsername({ kind: 'github', apiUrl }, 'wrong-token').catch((reason: Error) => reason)
    expect((error as Error).message).toContain('Токен не подошёл')
    expect((error as Error).message).not.toContain('wrong-token')
  })

  it('refuses a redirect to another origin, so the token cannot leak', async () => {
    const { apiUrl } = await setup('gitlab', { redirectTo: 'http://evil.example/steal' })
    await expect(forgeFetch({ kind: 'gitlab', apiUrl }, 'secret-token', '/user')).rejects.toThrow('другой адрес')
  })

  it('never offers a token to another host', async () => {
    const dir = await createRepo()
    const env = credentialEnv([{ host: 'github.com', username: 'x-access-token', token: 'tok-1' }])
    const fill = (host: string): Promise<string> => git(dir, ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...env, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    })
    const good = await fill('github.com')
    expect(good).toContain('username=x-access-token')
    expect(good).toContain('password=tok-1')
    await expect(fill('evil.example')).rejects.toThrow()
  })
})

describe('GitHub', () => {
  it('lists and creates Pull Requests', async () => {
    const { dir, state } = await setup('github', {})
    state.requests.push({ id: 1, source: 'feature', target: 'main', title: 'Existing' })
    expect((await forgeListRequests(dir)).map((item) => item.title)).toEqual(['Existing'])
    const created = await forgeCreateRequest(dir, { title: 'New', description: 'd', sourceBranch: 'feature', targetBranch: 'main', draft: false })
    expect(created).toMatchObject({ number: 2, sourceBranch: 'feature', targetBranch: 'main' })
  })

  it('reports classic protection, rulesets and open branches', async () => {
    const { dir, state } = await setup('github')
    expect(await forgeBranchInfo(dir, 'feature')).toMatchObject({ protected: false, forcePushAllowed: true })
    state.protections.main = { allowForcePush: false }
    expect(await forgeBranchInfo(dir, 'main')).toMatchObject({ protected: true, forcePushAllowed: false })
    state.protections.main = { allowForcePush: true }
    expect(await forgeBranchInfo(dir, 'main')).toMatchObject({ protected: true, forcePushAllowed: true })
    delete state.protections.main
    state.rulesets.main = ['non_fast_forward']
    expect(await forgeBranchInfo(dir, 'main')).toMatchObject({ protected: true, forcePushAllowed: false })
  })

  it('renames through the API so Pull Requests follow, and syncs the local branch', async () => {
    const { dir, bare, state } = await setup('github')
    state.requests.push(
      { id: 1, source: 'feature', target: 'main', title: 'From it' },
      { id: 2, source: 'other', target: 'feature', title: 'Into it' }
    )
    const preview = await forgeRenamePreview(dir, 'feature')
    expect(preview.following.map((item) => item.number)).toEqual([1, 2])
    expect(preview.stranded).toEqual([])
    const server = await head(bare, 'feature')
    await commitFile(dir, 'c.txt', '3\n', 'on main')
    await git(dir, ['switch', 'feature'])
    await commitFile(dir, 'unpushed.txt', 'u\n', 'unpushed work')
    const result = await forgeRenameBranch(dir, { oldName: 'feature', newName: 'renamed' })
    expect(result).toMatchObject({ oldBranchDeleted: true, movedRequests: 2, warnings: [] })
    expect(await head(bare, 'renamed')).toBe(server)
    expect(state.requests[0].source).toBe('renamed')
    expect(state.requests[1].target).toBe('renamed')
    const local = (await readRefs(dir)).find((ref) => ref.name === 'renamed')
    expect(local).toMatchObject({ upstream: 'origin/renamed', ahead: 1, isHead: true })
    expect((await readRefs(dir)).some((ref) => ref.name === 'origin/feature' || ref.name === 'feature')).toBe(false)
  })

  it('moves the default branch along, including the local record of it', async () => {
    const { dir, state } = await setup('github')
    await forgeRenameBranch(dir, { oldName: 'main', newName: 'trunk' })
    expect(state.defaultBranch).toBe('trunk')
    expect((await readRemotes(dir))[0].defaultBranch).toBe('trunk')
  })

  it('changes nothing when the new name is taken, on either side', async () => {
    const { dir, bare, state } = await setup('github')
    await git(dir, ['branch', 'taken-local'])
    await git(dir, ['switch', '-c', 'taken-remote'])
    await git(dir, ['push', '-q', 'origin', 'taken-remote'])
    await git(dir, ['switch', 'main'])
    await expect(forgeRenameBranch(dir, { oldName: 'feature', newName: 'taken-remote' })).rejects.toThrow('уже есть')
    await expect(forgeRenameBranch(dir, { oldName: 'feature', newName: 'taken-local' })).rejects.toThrow('уже существует')
    await expect(forgeRenameBranch(dir, { oldName: 'feature', newName: '--bad' })).rejects.toThrow('Недопустимое')
    expect(state.log.some((line) => line.includes('/rename'))).toBe(false)
    expect(await head(bare, 'feature')).toBeTruthy()
  })

  it('changes the default branch', async () => {
    const { dir, state } = await setup('github')
    await forgeSetDefaultBranch(dir, 'feature')
    expect(state.defaultBranch).toBe('feature')
    expect((await readRemotes(dir))[0].defaultBranch).toBe('feature')
  })
})

describe('GitLab', () => {
  it('sends the project path encoded, and marks drafts', async () => {
    const { dir, state } = await setup('gitlab')
    const created = await forgeCreateRequest(dir, { title: 'Wip', description: '', sourceBranch: 'feature', targetBranch: 'main', draft: true })
    expect(created).toMatchObject({ title: 'Draft: Wip', draft: true })
    expect(state.log.at(-1)).toContain('/projects/team%2Fproject/merge_requests')
  })

  it('reports protection', async () => {
    const { dir, state } = await setup('gitlab')
    state.protections.main = { allowForcePush: false }
    expect(await forgeBranchInfo(dir, 'main')).toMatchObject({ protected: true, forcePushAllowed: false })
    expect(await forgeBranchInfo(dir, 'feature')).toMatchObject({ protected: false, forcePushAllowed: true })
  })

  it('renames in steps: retargets requests, moves default and protection, deletes last', async () => {
    const { dir, bare, state } = await setup('gitlab')
    state.protections.main = { allowForcePush: true }
    state.requests.push({ id: 1, source: 'feature', target: 'main', title: 'Into main' })
    const result = await forgeRenameBranch(dir, { oldName: 'main', newName: 'trunk' })
    expect(result).toMatchObject({ oldBranchDeleted: true, movedRequests: 1, warnings: [] })
    expect(state.requests[0].target).toBe('trunk')
    expect(state.defaultBranch).toBe('trunk')
    expect(state.protections).toEqual({ trunk: { allowForcePush: true } })
    await expect(git(bare, ['rev-parse', '--verify', 'main'])).rejects.toThrow()
    expect((await readRefs(dir)).find((ref) => ref.name === 'trunk')).toMatchObject({ upstream: 'origin/trunk', isHead: true })
    const order = state.log.filter((line) => !line.startsWith('GET'))
    expect(order.at(-1)).toContain('DELETE')
    expect(order.at(-1)).toContain('repository/branches/main')
  })

  it('keeps the old branch when a Merge Request still comes from it', async () => {
    const { dir, bare, state } = await setup('gitlab')
    state.requests.push({ id: 7, source: 'feature', target: 'main', title: 'From feature' })
    const preview = await forgeRenamePreview(dir, 'feature')
    expect(preview.stranded.map((item) => item.number)).toEqual([7])
    const result = await forgeRenameBranch(dir, { oldName: 'feature', newName: 'renamed' })
    expect(result.oldBranchDeleted).toBe(false)
    expect(result.warnings[0]).toContain('!7')
    expect(await head(bare, 'feature')).toBe(await head(bare, 'renamed'))
    expect((await readRefs(dir)).map((ref) => ref.name)).toContain('origin/feature')
    expect((await readRefs(dir)).find((ref) => ref.name === 'renamed')?.upstream).toBe('origin/renamed')
  })

  it('stops before deleting if the server rejects an earlier step', async () => {
    const { dir, bare, state } = await setup('gitlab')
    await git(bare, ['branch', 'renamed', 'main'])
    await expect(forgeRenameBranch(dir, { oldName: 'feature', newName: 'renamed' })).rejects.toThrow('уже есть')
    expect(state.log.some((line) => line.startsWith('DELETE'))).toBe(false)
    expect(await gitLine(bare, ['rev-parse', '--verify', 'feature'])).toBeTruthy()
  })
})
