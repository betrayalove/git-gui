import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixCommands, fixDependencies, resolveProgram, runPackageManager } from '../src/core/deps-fix'
import { git, gitLine } from '../src/core/git'
import { parseLockfile } from '../src/core/lockfiles'
import type { DependencyFix } from '../src/shared/deps'
import { commitFile, createRepo, head, log, tempDir, write } from './helpers'
import { FakeNpmRegistry } from './npm-registry'

const savedEnv = { ...process.env }
let registry: FakeNpmRegistry

beforeAll(() => {
  // Package managers keep caches and settings in the home folder; all of it goes to a temporary one.
  const home = tempDir()
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'LocalAppData'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    npm_config_cache: join(home, 'npm-cache'),
    npm_config_userconfig: join(home, 'npmrc'),
    npm_config_store_dir: join(home, 'pnpm-store'),
    npm_config_fetch_retries: '0',
    // Anything that tries the public registry over https fails at once instead of reaching it.
    npm_config_https_proxy: 'http://127.0.0.1:9',
    npm_config_noproxy: '127.0.0.1',
    NO_PROXY: '127.0.0.1',
    YARN_HTTPS_PROXY: 'http://127.0.0.1:9',
    YARN_UNSAFE_HTTP_WHITELIST: '127.0.0.1',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_ENABLE_GLOBAL_CACHE: '0'
  })
})

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
})

async function startRegistry(options?: { publicTarballs: boolean }): Promise<void> {
  if (registry) await registry.stop()
  registry = new FakeNpmRegistry(options)
  const url = await registry.start()
  process.env.npm_config_registry = url
  process.env.YARN_NPM_REGISTRY_SERVER = url.replace(/\/$/, '')
}

beforeEach(() => startRegistry())

afterEach(async () => {
  await registry.stop()
})

const temporaryWorktrees = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('chronicle-deps-'))

/** A repository on `main` with a manifest and the lockfile the package manager wrote for it. */
async function project(manager: 'npm' | 'pnpm', manifest: object): Promise<string> {
  const repo = await createRepo()
  write(repo, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await runPackageManager(repo, manager === 'npm'
    ? ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'])
  await git(repo, ['add', '--all'])
  await git(repo, ['commit', '-m', 'Add dependencies'])
  return repo
}

function versions(repo: string, rev: string, lockfile: string, name: string): Promise<string[]> {
  return Promise.all([git(repo, ['show', `${rev}:${lockfile}`]), git(repo, ['show', `${rev}:package.json`])])
    .then(([text, manifest]) => parseLockfile(lockfile, text, manifest).packages.filter((item) => item.name === name).map((item) => item.version).sort())
}

/** Runs a fix and checks that the person's own checkout and branch did not move. */
async function fixAndCheck(repo: string, fix: DependencyFix): Promise<Awaited<ReturnType<typeof fixDependencies>>> {
  const before = await head(repo)
  const worktreesBefore = temporaryWorktrees()
  const result = await fixDependencies(repo, fix)
  expect(await head(repo)).toBe(before)
  expect(await gitLine(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe('main')
  expect(await git(repo, ['status', '--porcelain'])).toBe('')
  expect(await gitLine(repo, ['rev-parse', `${result.branch}^`])).toBe(before)
  expect(await head(repo, result.branch)).toBe(result.commit)
  expect((await git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n').filter((block) => block.trim())).toHaveLength(1)
  expect(temporaryWorktrees().filter((name) => !worktreesBefore.includes(name))).toEqual([])
  return result
}

async function expectNothingLeft(repo: string, before: string): Promise<void> {
  expect(await head(repo)).toBe(before)
  expect(await git(repo, ['branch', '--list', 'chronicle/*'])).toBe('')
  expect((await git(repo, ['worktree', 'list', '--porcelain'])).split('\n\n').filter((block) => block.trim())).toHaveLength(1)
}

describe('fixCommands', () => {
  it('lists lockfile-only commands with scripts off', () => {
    const commands = fixCommands({ lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })
    expect(commands).toEqual([
      ['npm', 'update', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--', 'leaf'],
      ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
    ])
    expect(fixCommands({ lockfile: 'web/pnpm-lock.yaml', manager: 'pnpm', updates: [{ name: 'a', from: '1.0.0', to: '1.0.1', direct: true }] })).toEqual([
      ['pnpm', 'install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'],
      ['pnpm', 'update', '--depth', 'Infinity', '--lockfile-only', '--ignore-scripts', '--', 'a']
    ])
    expect(fixCommands({ lockfile: 'yarn.lock', manager: 'yarn', updates: [{ name: '@s/a', from: '1.0.0', to: '2.0.0', direct: false }] })).toEqual([
      ['yarn', 'up', '--recursive', '--mode=update-lockfile', '--', '@s/a'],
      ['yarn', 'install', '--mode=update-lockfile']
    ])
    expect(fixCommands({ lockfile: 'requirements.txt', manager: 'pip', updates: [{ name: 'django', from: '3.2.0', to: '3.2.25', direct: true }] })).toEqual([])
  })

  it('refuses names, versions and paths that could be read as options', () => {
    const fix = (update: Partial<DependencyFix['updates'][number]>, lockfile = 'package-lock.json'): DependencyFix =>
      ({ lockfile, manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false, ...update }] })
    expect(() => fixCommands(fix({ name: '--registry=http://evil' }))).toThrow()
    expect(() => fixCommands(fix({ to: '--force' }))).toThrow()
    expect(() => fixCommands(fix({}, '../package-lock.json'))).toThrow()
    expect(() => fixCommands(fix({}, 'yarn.lock'))).toThrow()
    expect(() => fixCommands({ ...fix({}), manager: 'cargo' })).toThrow()
  })
})

describe('resolveProgram on Windows', () => {
  it('runs the JavaScript behind a .cmd wrapper with Node instead of going through cmd.exe', () => {
    const nodejs = tempDir()
    write(nodejs, 'npm.cmd', '@echo off\r\n')
    write(nodejs, 'node.exe', '')
    write(nodejs, 'node_modules/npm/bin/npm-cli.js', '')
    write(nodejs, 'pnpm.cmd', '@echo off\r\n')
    write(nodejs, 'node_modules/corepack/dist/pnpm.js', '')
    const setup = tempDir()
    write(setup, 'node_modules/.bin/yarn.cmd', '@echo off\r\n')
    write(setup, 'node_modules/yarn/bin/yarn.js', '')
    const volta = tempDir()
    write(volta, 'pnpm.exe', '')
    const env = { Path: [join(setup, 'node_modules', '.bin'), nodejs].join(';') }

    expect(resolveProgram('npm', env, 'win32')).toEqual({ file: join(nodejs, 'node.exe'), prefix: [join(nodejs, 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
    expect(resolveProgram('pnpm', env, 'win32')).toEqual({ file: join(nodejs, 'node.exe'), prefix: [join(nodejs, 'node_modules', 'corepack', 'dist', 'pnpm.js')] })
    expect(resolveProgram('yarn', env, 'win32')).toEqual({ file: 'node', prefix: [join(setup, 'node_modules', 'yarn', 'bin', 'yarn.js')] })
    expect(resolveProgram('pnpm', { PATH: `${volta};${nodejs}` }, 'win32')).toEqual({ file: join(volta, 'pnpm.exe'), prefix: [] })
    expect(() => resolveProgram('yarn', { PATH: nodejs }, 'win32')).toThrow()
    expect(resolveProgram('npm', env, 'linux')).toEqual({ file: 'npm', prefix: [] })
  })
})

describe('fixDependencies with npm', () => {
  it('raises a direct dependency and keeps its operator and the manifest formatting', async () => {
    registry.publish('minimist', '1.2.5').publish('other', '2.0.0')
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { minimist: '^1.2.5' }, devDependencies: { other: '2.0.0' } })
    const manifest = readFileSync(join(repo, 'package.json'), 'utf8')
    registry.publish('minimist', '1.2.6')

    const result = await fixAndCheck(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'minimist', from: '1.2.5', to: '1.2.6', direct: true }] })

    expect(result.branch).toBe('chronicle/deps-minimist-1.2.6')
    expect(result.changed).toEqual([{ name: 'minimist', from: '1.2.5', to: '1.2.6' }])
    expect(result.missed).toEqual([])
    expect(await git(repo, ['show', `${result.branch}:package.json`])).toBe(manifest.replace('"^1.2.5"', '"^1.2.6"'))
    expect(await versions(repo, result.branch, 'package-lock.json', 'minimist')).toEqual(['1.2.6'])
    expect(await log(repo, result.branch, '%B')).toEqual(['Update minimist to 1.2.6', 'Add dependencies'])
    expect(await git(repo, ['diff', '--name-only', 'main', result.branch])).toBe('package-lock.json\npackage.json\n')
  })

  it('re-resolves a transitive dependency within its range without an override', async () => {
    registry.publish('leaf', '1.0.0').publish('loose', '1.0.0', { leaf: '^1.0.0' })
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { loose: '1.0.0' } })
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })

    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    expect(await git(repo, ['diff', '--name-only', 'main', result.branch])).toBe('package-lock.json\n')
  })

  it('adds an override for a transitive dependency pinned to the old version', async () => {
    registry.publish('leaf', '1.0.0').publish('leaf', '2.0.0').publish('mid', '1.0.0', { leaf: '1.0.0' })
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { mid: '1.0.0', leaf: '^2.0.0' } })
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })
    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    expect(result.missed).toEqual([])
    const manifest = JSON.parse(await git(repo, ['show', `${result.branch}:package.json`])) as { overrides: Record<string, string> }
    expect(manifest.overrides).toEqual({ 'leaf@1.0.0': '^1.0.1' })
    expect(await versions(repo, result.branch, 'package-lock.json', 'leaf')).toEqual(['1.0.1', '2.0.0'])
  })

  it('makes no branch when the package manager cannot move the old version', async () => {
    registry.publish('leaf', '1.0.0')
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { leaf: '1.0.x' } })
    const before = await head(repo)

    await expect(fixDependencies(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: true }] }))
      .rejects.toThrow(/leaf@1\.0\.0/)
    await expectNothingLeft(repo, before)
  })

  it('makes no branch when the lockfile no longer has the old version', async () => {
    registry.publish('leaf', '1.0.1')
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { leaf: '^1.0.0' } })
    const before = await head(repo)

    await expect(fixDependencies(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: true }] }))
      .rejects.toThrow(/уже нет/)
    await expectNothingLeft(repo, before)
  })

  it('picks a new branch name when the first one is taken', async () => {
    registry.publish('leaf', '1.0.0').publish('loose', '1.0.0', { leaf: '^1.0.0' })
    const repo = await project('npm', { name: 'app', version: '1.0.0', dependencies: { loose: '1.0.0' } })
    await git(repo, ['branch', 'chronicle/deps-leaf-1.0.1'])
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'package-lock.json', manager: 'npm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })
    expect(result.branch).toBe('chronicle/deps-leaf-1.0.1-2')
  })
})

describe('fixDependencies with pnpm', () => {
  it('raises a direct dependency in a project inside a folder', async () => {
    registry.publish('minimist', '1.2.5')
    const repo = await createRepo()
    write(repo, 'web/package.json', `${JSON.stringify({ name: 'web', version: '1.0.0', dependencies: { minimist: '~1.2.5' } }, null, 2)}\n`)
    await runPackageManager(join(repo, 'web'), ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'])
    await git(repo, ['add', '--all'])
    await git(repo, ['commit', '-m', 'Add web'])
    registry.publish('minimist', '1.2.6')

    const result = await fixAndCheck(repo, { lockfile: 'web/pnpm-lock.yaml', manager: 'pnpm', updates: [{ name: 'minimist', from: '1.2.5', to: '1.2.6', direct: true }] })

    expect(result.changed).toEqual([{ name: 'minimist', from: '1.2.5', to: '1.2.6' }])
    expect(await git(repo, ['show', `${result.branch}:web/package.json`])).toContain('"minimist": "~1.2.6"')
    expect(await git(repo, ['diff', '--name-only', 'main', result.branch])).toBe('web/package.json\nweb/pnpm-lock.yaml\n')
  })

  it('re-resolves a transitive dependency within its range', async () => {
    registry.publish('leaf', '1.0.0').publish('loose', '1.0.0', { leaf: '^1.0.0' })
    const repo = await project('pnpm', { name: 'app', version: '1.0.0', dependencies: { loose: '1.0.0' } })
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'pnpm-lock.yaml', manager: 'pnpm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })

    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    expect(await git(repo, ['diff', '--name-only', 'main', result.branch])).toBe('pnpm-lock.yaml\n')
  })

  it('adds an override for a transitive dependency pinned to the old version', async () => {
    registry.publish('leaf', '1.0.0').publish('leaf', '2.0.0').publish('mid', '1.0.0', { leaf: '1.0.0' })
    const repo = await project('pnpm', { name: 'app', version: '1.0.0', dependencies: { mid: '1.0.0', leaf: '^2.0.0' } })
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'pnpm-lock.yaml', manager: 'pnpm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })

    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    expect(await versions(repo, result.branch, 'pnpm-lock.yaml', 'leaf')).toEqual(['1.0.1', '2.0.0'])
    const changedFiles = await git(repo, ['diff', '--name-only', 'main', result.branch])
    if (changedFiles.includes('pnpm-workspace.yaml')) {
      expect(await git(repo, ['show', `${result.branch}:pnpm-workspace.yaml`])).toContain(`'leaf@1.0.0': '^1.0.1'`)
    } else {
      const manifest = JSON.parse(await git(repo, ['show', `${result.branch}:package.json`])) as { pnpm: { overrides: Record<string, string> } }
      expect(manifest.pnpm.overrides).toEqual({ 'leaf@1.0.0': '^1.0.1' })
    }
  })

  it('keeps overrides in pnpm-workspace.yaml when the project already has them there', async () => {
    registry.publish('leaf', '1.0.0').publish('mid', '1.0.0', { leaf: '1.0.0' }).publish('other', '1.0.0')
    const repo = await createRepo()
    write(repo, 'pnpm-workspace.yaml', 'packages:\n  - .\noverrides:\n  other: 1.0.0\n')
    const repoProject = await (async (): Promise<string> => {
      write(repo, 'package.json', `${JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { mid: '1.0.0', other: '^1.0.0' } }, null, 2)}\n`)
      await runPackageManager(repo, ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'])
      await git(repo, ['add', '--all'])
      await git(repo, ['commit', '-m', 'Add dependencies'])
      return repo
    })()
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repoProject, { lockfile: 'pnpm-lock.yaml', manager: 'pnpm', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })

    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    expect(await git(repo, ['show', `${result.branch}:pnpm-workspace.yaml`])).toBe(`packages:\n  - .\noverrides:\n  'leaf@1.0.0': '^1.0.1'\n  other: 1.0.0\n`)
    expect(await git(repo, ['diff', '--name-only', 'main', result.branch])).toBe('pnpm-lock.yaml\npnpm-workspace.yaml\n')
  })
})

/**
 * Yarn 2+ is not installed globally anywhere: projects commit their release and `yarnPath` points
 * to it. A test can run only with such a release at hand, given as CHRONICLE_TEST_YARN_RELEASE.
 */
const yarnRelease = savedEnv.CHRONICLE_TEST_YARN_RELEASE
describe.skipIf(!yarnRelease || !existsSync(yarnRelease))('fixDependencies with Yarn 2+', () => {
  // Yarn downloads from the address the registry gives whenever it is not its own registry's.
  beforeEach(() => startRegistry({ publicTarballs: false }))

  async function yarnProject(manifest: object): Promise<string> {
    const repo = await createRepo()
    mkdirSync(join(repo, '.yarn', 'releases'), { recursive: true })
    copyFileSync(yarnRelease!, join(repo, '.yarn', 'releases', 'yarn.cjs'))
    write(repo, '.yarnrc.yml', 'yarnPath: .yarn/releases/yarn.cjs\n')
    write(repo, '.gitignore', '.yarn/cache\n.yarn/install-state.gz\n')
    write(repo, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    await runPackageManager(repo, ['yarn', 'install', '--mode=update-lockfile'])
    await git(repo, ['add', '--all'])
    await git(repo, ['commit', '-m', 'Add dependencies'])
    return repo
  }

  it('raises a direct dependency', async () => {
    registry.publish('minimist', '1.2.5')
    const repo = await yarnProject({ name: 'app', version: '1.0.0', dependencies: { minimist: '^1.2.5' } })
    registry.publish('minimist', '1.2.6')

    const result = await fixAndCheck(repo, { lockfile: 'yarn.lock', manager: 'yarn', updates: [{ name: 'minimist', from: '1.2.5', to: '1.2.6', direct: true }] })

    expect(result.changed).toEqual([{ name: 'minimist', from: '1.2.5', to: '1.2.6' }])
    expect(await git(repo, ['show', `${result.branch}:package.json`])).toContain('"minimist": "^1.2.6"')
  })

  it('adds a resolution for a transitive dependency pinned to the old version', async () => {
    registry.publish('leaf', '1.0.0').publish('leaf', '2.0.0').publish('mid', '1.0.0', { leaf: '1.0.0' })
    const repo = await yarnProject({ name: 'app', version: '1.0.0', dependencies: { mid: '1.0.0', leaf: '^2.0.0' } })
    registry.publish('leaf', '1.0.1')

    const result = await fixAndCheck(repo, { lockfile: 'yarn.lock', manager: 'yarn', updates: [{ name: 'leaf', from: '1.0.0', to: '1.0.1', direct: false }] })

    expect(result.changed).toEqual([{ name: 'leaf', from: '1.0.0', to: '1.0.1' }])
    const manifest = JSON.parse(await git(repo, ['show', `${result.branch}:package.json`])) as { resolutions: Record<string, string> }
    expect(manifest.resolutions).toEqual({ 'leaf@npm:1.0.0': '1.0.1' })
  })
})

describe('fixDependencies with Yarn 1', () => {
  it('names the manual command instead of running Yarn', async () => {
    const repo = await createRepo()
    write(repo, 'package.json', '{"name":"app","dependencies":{"minimist":"^1.2.5"}}\n')
    const before = await commitFile(repo, 'yarn.lock', '# yarn lockfile v1\n\nminimist@^1.2.5:\n  version "1.2.5"\n  resolved "https://registry.yarnpkg.com/minimist/-/minimist-1.2.5.tgz"\n', 'Add lockfile')

    await expect(fixDependencies(repo, { lockfile: 'yarn.lock', manager: 'yarn', updates: [{ name: 'minimist', from: '1.2.5', to: '1.2.6', direct: true }] }))
      .rejects.toThrow('yarn upgrade minimist@1.2.6')
    await expectNothingLeft(repo, before)
  })
})

describe('fixDependencies with requirements.txt', () => {
  it('changes only the pinned version and keeps the rest of each line', async () => {
    const repo = await createRepo()
    const text = [
      '# Web',
      'Django==3.2.0 ; python_version >= "3.8"  # framework',
      'requests[socks] == 2.25.0\r',
      'flask>=2.0',
      'hashed==1.0.0 \\',
      '    --hash=sha256:0000000000000000000000000000000000000000000000000000000000000000',
      ''
    ].join('\n')
    await commitFile(repo, 'requirements.txt', text, 'Add requirements')

    const result = await fixAndCheck(repo, { lockfile: 'requirements.txt', manager: 'pip', updates: [
      { name: 'django', from: '3.2.0', to: '3.2.25', direct: true },
      { name: 'requests', from: '2.25.0', to: '2.31.0', direct: true },
      { name: 'hashed', from: '1.0.0', to: '1.0.1', direct: true }
    ] })

    expect(await git(repo, ['show', `${result.branch}:requirements.txt`])).toBe(text
      .replace('Django==3.2.0 ;', 'Django==3.2.25 ;')
      .replace('requests[socks] == 2.25.0', 'requests[socks] == 2.31.0'))
    expect(result.changed).toEqual([{ name: 'django', from: '3.2.0', to: '3.2.25' }, { name: 'requests', from: '2.25.0', to: '2.31.0' }])
    expect(result.missed).toEqual(['hashed@1.0.0'])
    expect(result.branch).toBe('chronicle/deps-3-updates')
    expect(await log(repo, result.branch, '%B')).toEqual(['Update 2 dependencies', '- django 3.2.0 -> 3.2.25', '- requests 2.25.0 -> 2.31.0', 'Add requirements'])
  })
})
