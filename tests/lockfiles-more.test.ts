import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLockfile, readLockfiles } from '../src/core/lockfiles'
import type { LockedPackage } from '../src/shared/deps'
import { commitFile, createRepo } from './helpers'

const FIXTURES = join(__dirname, 'fixtures', 'lockfiles')
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')
const sorted = (packages: LockedPackage[]): LockedPackage[] => [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const read = (file: string, text: string, manifest: string | null = null): LockedPackage[] => sorted(parseLockfile(file, text, manifest).packages)
const runtime = (name: string, version: string, dependencies: string[] = []): LockedPackage => ({ name, version, direct: true, dev: false, dependencies })
const pulled = (name: string, version: string, dependencies: string[] = []): LockedPackage => ({ name, version, direct: false, dev: false, dependencies })
const devOnly = (name: string, version: string, dependencies: string[] = []): LockedPackage => ({ name, version, direct: true, dev: true, dependencies })

/** The Python sample: Jinja2 pulls in MarkupSafe, urllib3 is direct and iniconfig is for development. */
const PYTHON: LockedPackage[] = [
  devOnly('iniconfig', '2.0.0'),
  runtime('jinja2', '2.11.2', ['markupsafe@3.0.4']),
  pulled('markupsafe', '3.0.4'),
  runtime('urllib3', '1.26.4')
]

describe('reading lockfiles of other ecosystems', () => {
  it('reads Cargo.lock, leaving out the workspace and git crates', () => {
    const lockfile = parseLockfile('Cargo.lock', fixture('cargo/Cargo.lock'), null)
    expect(lockfile).toMatchObject({ ecosystem: 'crates.io', manager: 'cargo' })
    expect(sorted(lockfile.packages)).toEqual([
      pulled('aho-corasick', '0.7.18', ['memchr@2.4.1']),
      runtime('hex', '0.4.3'),
      pulled('maybe-uninit', '2.0.0'),
      pulled('memchr', '2.4.1'),
      runtime('regex', '1.5.4', ['aho-corasick@0.7.18', 'memchr@2.4.1', 'regex-syntax@0.6.25']),
      pulled('regex-syntax', '0.6.25'),
      runtime('smallvec', '0.6.14', ['maybe-uninit@2.0.0']),
      runtime('smallvec', '1.6.0')
    ])
  })

  it('reads crates from the sparse index and leaves out other registries', () => {
    const lock = [
      'version = 4',
      '[[package]]',
      'name = "app"',
      'version = "0.1.0"',
      'dependencies = ["inner", "secret"]',
      '[[package]]',
      'name = "inner"',
      'version = "1.0.0"',
      'source = "sparse+https://index.crates.io/"',
      '[[package]]',
      'name = "secret"',
      'version = "2.0.0"',
      'source = "sparse+https://crates.example.com/index/"'
    ].join('\n')
    expect(read('Cargo.lock', lock)).toEqual([runtime('inner', '1.0.0')])
  })

  it('reads go.mod, leaving out modules replaced with a local folder', () => {
    const lockfile = parseLockfile('go.mod', fixture('go/go.mod'), null)
    expect(lockfile).toMatchObject({ ecosystem: 'Go', manager: 'go' })
    expect(sorted(lockfile.packages)).toEqual([
      runtime('github.com/gorilla/websocket', 'v1.4.0'),
      pulled('github.com/magefile/mage', 'v1.10.0'),
      runtime('github.com/sirupsen/logrus', 'v1.8.0'),
      pulled('golang.org/x/sys', 'v0.0.0-20191026070338-33540a1f6037'),
      runtime('golang.org/x/text', 'v0.3.5')
    ])
  })

  it('follows a module replaced with another module in go.mod', () => {
    const mod = [
      'module example.com/app',
      '',
      'go 1.22',
      'require golang.org/x/net v0.1.0',
      'require github.com/old/lib v1.0.0 // indirect',
      'replace github.com/old/lib v1.0.0 => github.com/new/lib v1.2.0'
    ].join('\n')
    expect(read('go.mod', mod)).toEqual([pulled('github.com/new/lib', 'v1.2.0'), runtime('golang.org/x/net', 'v0.1.0')])
  })

  it('reads poetry.lock with its pyproject.toml, leaving out git and local packages', () => {
    const lockfile = parseLockfile('poetry.lock', fixture('poetry/poetry.lock'), fixture('poetry/pyproject.toml'))
    expect(lockfile).toMatchObject({ ecosystem: 'PyPI', manager: 'poetry' })
    expect(sorted(lockfile.packages)).toEqual(PYTHON)
  })

  it('reads the standard pyproject.toml sections next to poetry.lock', () => {
    const manifest = [
      '[project]',
      'name = "app"',
      'description = """',
      'An app with [brackets] and # signs',
      '"""',
      'dependencies = [',
      '    "Jinja2 (==2.11.2)",',
      '    "urllib3[socks]>=1.26 ; python_version >= \'3.9\'",',
      ']',
      '',
      '[dependency-groups]',
      'dev = ["iniconfig==2.0.0", { include-group = "lint" }]'
    ].join('\n')
    expect(read('poetry.lock', fixture('poetry/poetry.lock'), manifest)).toEqual(PYTHON)
  })

  it('reads dev groups from poetry.lock when pyproject.toml is missing', () => {
    expect(read('poetry.lock', fixture('poetry/poetry.lock'))).toEqual(PYTHON.map((item) => ({ ...item, direct: false })))
  })

  it('reads the old Poetry dev section and leaves out private indexes', () => {
    const lock = [
      '[[package]]',
      'name = "Flask_Cors"',
      'version = "3.0.8"',
      'category = "dev"',
      '',
      '[[package]]',
      'name = "internal"',
      'version = "1.0.0"',
      'category = "main"',
      '',
      '[package.source]',
      'type = "legacy"',
      'url = "https://pypi.example.com/simple"',
      'reference = "private"'
    ].join('\n')
    const manifest = '[tool.poetry.dev-dependencies]\n"flask-cors" = "^3.0"\n'
    expect(read('poetry.lock', lock, manifest)).toEqual([devOnly('flask-cors', '3.0.8')])
  })

  it('reads uv.lock, counting optional dependencies as dev and leaving out local folders', () => {
    const lockfile = parseLockfile('uv.lock', fixture('uv/uv.lock'), null)
    expect(lockfile).toMatchObject({ ecosystem: 'PyPI', manager: 'uv' })
    expect(sorted(lockfile.packages)).toEqual([...PYTHON.slice(0, 3), devOnly('pysocks', '1.7.1'), PYTHON[3]])
  })

  it('tells apart two versions of one package in uv.lock', () => {
    const lock = [
      'version = 1',
      '[[package]]',
      'name = "app"',
      'version = "0.1.0"',
      'source = { virtual = "." }',
      'dependencies = [',
      '    { name = "numpy", version = "1.24.4", source = { registry = "https://pypi.org/simple" }, marker = "python_full_version < \'3.9\'" },',
      '    { name = "numpy", version = "2.0.2", source = { registry = "https://pypi.org/simple" }, marker = "python_full_version >= \'3.9\'" },',
      '    { name = "internal" },',
      ']',
      '[[package]]',
      'name = "numpy"',
      'version = "1.24.4"',
      'source = { registry = "https://pypi.org/simple" }',
      '[[package]]',
      'name = "numpy"',
      'version = "2.0.2"',
      'source = { registry = "https://pypi.org/simple" }',
      '[[package]]',
      'name = "internal"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.example.com/simple" }'
    ].join('\n')
    expect(read('uv.lock', lock)).toEqual([runtime('numpy', '1.24.4'), runtime('numpy', '2.0.2')])
  })

  it('reads Pipfile.lock, taking direct packages from the Pipfile', () => {
    const lockfile = parseLockfile('Pipfile.lock', fixture('pipenv/Pipfile.lock'), fixture('pipenv/Pipfile'))
    expect(lockfile).toMatchObject({ ecosystem: 'PyPI', manager: 'pipenv' })
    expect(sorted(lockfile.packages)).toEqual(PYTHON.map((item) => ({ ...item, dependencies: [] })))
  })

  it('counts every Pipfile.lock package as direct without the Pipfile, and leaves out private indexes', () => {
    const lock = JSON.parse(fixture('pipenv/Pipfile.lock')) as { _meta: { sources: { name: string; url: string; verify_ssl: boolean }[] }; default: Record<string, object> }
    lock._meta.sources.push({ name: 'private', url: 'https://pypi.example.com/simple', verify_ssl: true })
    lock.default.internal = { index: 'private', version: '==1.0.0' }
    expect(read('Pipfile.lock', JSON.stringify(lock))).toEqual(PYTHON.map((item) => ({ ...item, direct: true, dependencies: [] })))
  })

  it('reads exact pins from requirements.txt as written by a lock tool', () => {
    const lockfile = parseLockfile('requirements.txt', fixture('pip/requirements.txt'), null)
    expect(lockfile).toMatchObject({ ecosystem: 'PyPI', manager: 'pip' })
    expect(sorted(lockfile.packages)).toEqual([
      runtime('jinja2', '2.11.2'), runtime('markupsafe', '3.0.4'), runtime('pysocks', '1.7.1'), runtime('urllib3', '1.26.4')
    ])
  })

  it('reads only exact pins from a hand-written requirements.txt', () => {
    const requirements = [
      '# Pinned for production',
      '-r base.txt',
      '--index-url https://pypi.org/simple',
      '-e ./local',
      'Flask_Cors[extra]==3.0.8 ; python_version >= "3.8"  # keep',
      'requests==2.25.1 \\',
      '    --hash=sha256:c210084e36a42ae6b9219e00e48287def368a26d03a048ddad7bfee44f75871e',
      'django>=3.2',
      'odd===1.0',
      'wild==1.*',
      'mine @ https://example.com/mine-1.0.tar.gz',
      'git+https://github.com/example/tool.git#egg=tool'
    ].join('\n')
    expect(read('requirements.txt', requirements)).toEqual([runtime('flask-cors', '3.0.8'), runtime('requests', '2.25.1')])
  })

  it('reads Gemfile.lock, leaving out git and path gems and platform suffixes', () => {
    const lockfile = parseLockfile('Gemfile.lock', fixture('bundler/Gemfile.lock'), null)
    expect(lockfile).toMatchObject({ ecosystem: 'RubyGems', manager: 'bundler' })
    expect(sorted(lockfile.packages)).toEqual([
      pulled('mini_portile2', '2.7.1'),
      runtime('nokogiri', '1.13.0', ['mini_portile2@2.7.1', 'racc@1.8.1']),
      pulled('racc', '1.8.1'),
      runtime('rack', '2.2.3'),
      runtime('rake', '13.0.6')
    ])
  })

  it('leaves out gems from a private server', () => {
    const lock = [
      'GEM',
      '  remote: https://gems.example.com/',
      '  specs:',
      '    internal (1.0.0)',
      '      rack (>= 2)',
      '',
      'GEM',
      '  remote: https://rubygems.org/',
      '  specs:',
      '    rack (2.2.3)',
      '',
      'DEPENDENCIES',
      '  internal!',
      '  rack'
    ].join('\n')
    expect(read('Gemfile.lock', lock)).toEqual([runtime('rack', '2.2.3')])
  })

  it('reads composer.lock with composer.json, leaving out path packages', () => {
    const lockfile = parseLockfile('composer.lock', fixture('composer/composer.lock'), fixture('composer/composer.json'))
    expect(lockfile).toMatchObject({ ecosystem: 'Packagist', manager: 'composer' })
    expect(sorted(lockfile.packages)).toEqual([
      runtime('guzzlehttp/psr7', '1.8.1', ['psr/http-message@1.0.1', 'ralouphie/getallheaders@3.0.3']),
      devOnly('mikey179/vfsstream', 'v1.6.10'),
      pulled('psr/http-message', '1.0.1'),
      pulled('ralouphie/getallheaders', '3.0.3')
    ])
  })

  it('takes dev packages from composer.lock alone when composer.json is missing', () => {
    expect(read('composer.lock', fixture('composer/composer.lock')).map((item) => [item.name, item.direct, item.dev])).toEqual([
      ['guzzlehttp/psr7', false, false],
      ['mikey179/vfsstream', false, true],
      ['psr/http-message', false, false],
      ['ralouphie/getallheaders', false, false]
    ])
  })

  it.each([
    ['Cargo.lock', '[[package]]\nname = "a"\nthis is not toml\n', 'Строка 3 в Cargo.lock не читается.'],
    ['Cargo.lock', '[[package]]\nversion = "1.0.0"\n', 'Файл Cargo.lock устроен не так, как ожидалось.'],
    ['go.mod', 'module example.com/app\nrequire (\n\tgolang.org/x/net\n)\n', 'Строка 3 в go.mod не читается.'],
    ['go.mod', 'go 1.22\n', 'Файл go.mod устроен не так, как ожидалось.'],
    ['go.mod', '{"module": "example.com/app"}', 'Строка 1 в go.mod не читается.'],
    ['poetry.lock', '[[package]]\nname = "a"\nfiles = [\n', 'Строка 3 в poetry.lock не читается.'],
    ['uv.lock', '<html></html>', 'Строка 1 в uv.lock не читается.'],
    ['Pipfile.lock', '{"_meta": {}}', 'Файл Pipfile.lock устроен не так, как ожидалось.'],
    ['requirements.txt', 'flask==2.0.0\n<html>\n', 'Строка 2 в requirements.txt не читается.'],
    ['Gemfile.lock', 'GEM\n  remote: https://rubygems.org/\nnot a section\n', 'Строка 3 в Gemfile.lock не читается.'],
    ['composer.lock', '{"packages-dev": []}', 'Файл composer.lock устроен не так, как ожидалось.']
  ])('rejects a broken %s', (file, text, message) => {
    expect(() => parseLockfile(file, text, null)).toThrow(message)
  })

  it('finds these lockfiles in a commit with the files next to them', async () => {
    const repo = await createRepo()
    await commitFile(repo, 'api/poetry.lock', fixture('poetry/poetry.lock'), 'Add lockfile')
    await commitFile(repo, 'api/pyproject.toml', fixture('poetry/pyproject.toml'), 'Add project')
    await commitFile(repo, 'site/Gemfile.lock', fixture('bundler/Gemfile.lock'), 'Add site')
    await commitFile(repo, 'vendor/lib/composer.lock', '{}', 'Vendor a library')
    const { lockfiles, skipped } = await readLockfiles(repo)
    expect(lockfiles.map((item) => [item.path, item.ecosystem, item.manager])).toEqual([['api/poetry.lock', 'PyPI', 'poetry'], ['site/Gemfile.lock', 'RubyGems', 'bundler']])
    expect(lockfiles[0].packages).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'iniconfig', direct: true, dev: true })]))
    expect(skipped).toEqual([])
  })
})
