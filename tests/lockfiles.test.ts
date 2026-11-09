import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLockfile, parseLockYaml, readLockfiles } from '../src/core/lockfiles'
import type { LockedPackage } from '../src/shared/deps'
import { commitFile, createRepo } from './helpers'

const FIXTURES = join(__dirname, 'fixtures', 'lockfiles')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const manifest = fixture('package.json')

/** The sample project: three runtime packages, one of which pulls in `ms`, and a dev-only one. */
const SAMPLE: LockedPackage[] = [
  { name: '@sindresorhus/is', version: '0.14.0', direct: true, dev: false, dependencies: [] },
  { name: 'debug', version: '2.6.8', direct: true, dev: false, dependencies: ['ms@2.0.0'] },
  { name: 'lodash', version: '4.18.1', direct: true, dev: false, dependencies: [] },
  { name: 'minimist', version: '1.2.0', direct: true, dev: true, dependencies: [] },
  { name: 'ms', version: '2.0.0', direct: false, dev: false, dependencies: [] }
]
const sorted = (packages: LockedPackage[]): LockedPackage[] => [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

describe('reading lockfiles', () => {
  it.each([
    ['package-lock.json', 'package-lock.json'],
    ['pnpm-lock.yaml', 'pnpm-lock.yaml'],
    ['yarn.lock', 'yarn-classic.lock'],
    ['yarn.lock', 'yarn-berry.lock']
  ])('reads %s (%s) into the same packages', (file, name) => {
    expect(sorted(parseLockfile(file, fixture(name), manifest).packages)).toEqual(SAMPLE)
  })

  it('reads its own pnpm lockfile, where everything is for development', () => {
    const own = parseLockfile('pnpm-lock.yaml', readFileSync(join(__dirname, '..', 'pnpm-lock.yaml'), 'utf8'), null)
    const electron = own.packages.find((item) => item.name === 'electron')
    expect(electron).toMatchObject({ direct: true, dev: true })
    expect(own.packages.length).toBeGreaterThan(300)
    expect(own.packages.every((item) => item.dev)).toBe(true)
    expect(own.packages.some((item) => item.name === '@types/react-dom' && item.direct)).toBe(true)
  })

  it('leaves out packages that are not from the public registry', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { local: 'file:../local', secret: '^1.0.0', open: '^2.0.0' } },
        'node_modules/local': { link: true, resolved: '../local' },
        'node_modules/secret': { version: '1.0.0', resolved: 'https://npm.example.com/secret/-/secret-1.0.0.tgz' },
        'node_modules/open': { version: '2.0.0', resolved: 'https://registry.npmjs.org/open/-/open-2.0.0.tgz', dependencies: { inner: '^1' } },
        'node_modules/open/node_modules/inner': { version: '1.5.0', resolved: 'https://registry.npmjs.org/inner/-/inner-1.5.0.tgz' },
        'node_modules/inner': { version: '0.1.0', resolved: 'https://registry.npmjs.org/inner/-/inner-0.1.0.tgz' }
      }
    })
    expect(sorted(parseLockfile('package-lock.json', lock, null).packages)).toEqual([
      { name: 'inner', version: '0.1.0', direct: false, dev: true, dependencies: [] },
      { name: 'inner', version: '1.5.0', direct: false, dev: false, dependencies: [] },
      { name: 'open', version: '2.0.0', direct: true, dev: false, dependencies: ['inner@1.5.0'] }
    ])
  })

  it('reads aliases and peer suffixes in pnpm lockfiles', () => {
    const lock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      strip:',
      '        specifier: npm:strip-ansi@^6',
      '        version: strip-ansi@6.0.1',
      '      plugin:',
      '        specifier: ^1',
      '        version: 1.0.0(host@2.0.0)',
      '      mine:',
      '        specifier: link:../mine',
      '        version: link:../mine',
      'packages:',
      '  strip-ansi@6.0.1:',
      '    resolution: {integrity: sha512-x}',
      '  plugin@1.0.0:',
      '    resolution: {integrity: sha512-y}',
      '  host@2.0.0:',
      '    resolution: {tarball: https://npm.example.com/host-2.0.0.tgz}',
      'snapshots:',
      '  strip-ansi@6.0.1: {}',
      '  plugin@1.0.0(host@2.0.0):',
      '    dependencies:',
      '      host: 2.0.0',
      '  host@2.0.0: {}'
    ].join('\n')
    expect(sorted(parseLockfile('pnpm-lock.yaml', lock, null).packages)).toEqual([
      { name: 'plugin', version: '1.0.0', direct: true, dev: false, dependencies: [] },
      { name: 'strip-ansi', version: '6.0.1', direct: true, dev: false, dependencies: [] }
    ])
  })

  it('reads quoted keys and lists in lockfile YAML', () => {
    expect(parseLockYaml("'a: b''s':\n  - one\n  - 'two'\n\"c\": d\n")).toEqual({ "a: b's": ['one', 'two'], c: 'd' })
  })

  it('finds lockfiles in a commit and reports the ones it cannot read', async () => {
    const repo = await createRepo()
    await commitFile(repo, 'web/package-lock.json', fixture('package-lock.json'), 'Add web')
    await commitFile(repo, 'node_modules/x/package-lock.json', '{}', 'Vendor a package')
    await commitFile(repo, 'old/package-lock.json', '{"lockfileVersion":1,"dependencies":{}}', 'Add old')
    const { lockfiles, skipped } = await readLockfiles(repo)
    expect(lockfiles.map((item) => [item.path, item.manager, item.packages.length])).toEqual([['web/package-lock.json', 'npm', 5]])
    expect(skipped.map((item) => item.path)).toEqual(['old/package-lock.json'])
  })
})
