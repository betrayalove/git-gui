import { describe, expect, it } from 'vitest'
import { forgeContext } from '../src/core/forge'
import { git } from '../src/core/git'
import { branchSettingsUrl, defaultBranchSettingsUrl, kindForHost, newRequestUrl, parseRemoteUrl, requestsPageUrl } from '../src/shared/remote-url'
import type { ForgeContext } from '../src/shared/types'
import { createRepo } from './helpers'

describe('parsing remote URLs', () => {
  it.each([
    ['git@github.com:owner/repo.git', { host: 'github.com', path: 'owner/repo', protocol: 'ssh', user: 'git' }],
    ['git@gitlab.com:group/sub/repo.git', { host: 'gitlab.com', path: 'group/sub/repo', protocol: 'ssh', user: 'git' }],
    ['host.example:team/repo', { host: 'host.example', path: 'team/repo', protocol: 'ssh' }],
    ['https://github.com/owner/repo', { host: 'github.com', path: 'owner/repo', protocol: 'https' }],
    ['https://github.com/owner/repo.git/', { host: 'github.com', path: 'owner/repo', protocol: 'https' }],
    ['https://user@gitlab.example.com/group/sub/repo.git', { host: 'gitlab.example.com', path: 'group/sub/repo', protocol: 'https' }],
    ['ssh://git@gitlab.example.com:2222/group/repo.git', { host: 'gitlab.example.com', path: 'group/repo', protocol: 'ssh', user: 'git', port: 2222 }],
    ['https://GitHub.com/owner/repo', { host: 'github.com', path: 'owner/repo', protocol: 'https' }],
    ['http://127.0.0.1:8080/a/b.git', { host: '127.0.0.1:8080', path: 'a/b', protocol: 'http' }]
  ])('reads %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected)
  })

  it.each(['/local/path/repo.git', 'C:\\Users\\me\\repo.git', 'file:///srv/repo.git', '../relative/repo', 'https://github.com/only-one'])(
    'rejects %s', (url) => { expect(parseRemoteUrl(url)).toBeNull() }
  )

  it('tells the server type from its name', () => {
    expect(kindForHost('github.com')).toBe('github')
    expect(kindForHost('github.corp.example')).toBe('github')
    expect(kindForHost('gitlab.com')).toBe('gitlab')
    expect(kindForHost('gitlab.example.com:8443')).toBe('gitlab')
    expect(kindForHost('code.corp.example')).toBeNull()
    expect(kindForHost('notgithub.com')).toBeNull()
  })
})

describe('context', () => {
  it('needs no account and treats local remotes as nothing', async () => {
    const dir = await createRepo()
    expect(await forgeContext(dir)).toBeNull()
    await git(dir, ['remote', 'add', 'origin', 'git@gitlab.com:team/app.git'])
    expect(await forgeContext(dir)).toMatchObject({ kind: 'gitlab', path: 'team/app', webUrl: 'https://gitlab.com/team/app', remote: 'origin' })
    await git(dir, ['remote', 'set-url', 'origin', 'git@code.corp.example:team/app.git'])
    expect(await forgeContext(dir)).toMatchObject({ kind: null, host: 'code.corp.example' })
    await git(dir, ['remote', 'set-url', 'origin', '/srv/app.git'])
    expect(await forgeContext(dir)).toBeNull()
  })
})

describe('links to the site', () => {
  const context = (kind: ForgeContext['kind']): ForgeContext => ({
    kind, host: 'example.com', path: 'team/app', webUrl: 'https://example.com/team/app', remote: 'origin', url: 'git@example.com:team/app.git'
  })

  it('opens a new request with the branch chosen', () => {
    expect(newRequestUrl(context('github'), 'feature/один')).toBe('https://example.com/team/app/compare/feature/%D0%BE%D0%B4%D0%B8%D0%BD?expand=1')
    expect(newRequestUrl(context('gitlab'), 'feature/x')).toBe('https://example.com/team/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx')
    expect(newRequestUrl(context(null), 'feature')).toBeNull()
  })

  it('finds the settings and request pages', () => {
    expect(requestsPageUrl(context('github'))).toBe('https://example.com/team/app/pulls')
    expect(requestsPageUrl(context('gitlab'))).toBe('https://example.com/team/app/-/merge_requests')
    expect(branchSettingsUrl(context('github'))).toBe('https://example.com/team/app/settings/branches')
    expect(branchSettingsUrl(context('gitlab'))).toBe('https://example.com/team/app/-/settings/repository')
    expect(defaultBranchSettingsUrl(context('github'))).toBe('https://example.com/team/app/settings')
    expect(requestsPageUrl(context(null))).toBeNull()
  })
})
