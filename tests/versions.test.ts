import { describe, expect, it } from 'vitest'
import type { Ecosystem } from '../src/shared/deps'
import { compareVersions, isPrerelease, updateKind } from '../src/shared/versions'

/** Each list is in ascending order; every pair is checked both ways. */
const ascending: [Ecosystem, string[]][] = [
  ['npm', ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.9.0', '1.10.0', '2.0.0']],
  ['crates.io', ['0.9.9', '0.10.0-rc.1', '0.10.0', '0.10.1', '1.0.0-0', '1.0.0-1', '1.0.0-a', '1.0.0']],
  ['Go', [
    'v0.0.0-20210101000000-abcdef123456',
    'v0.0.0-20220315120000-123456abcdef',
    'v0.1.0',
    'v1.2.3',
    'v1.2.4-0.20210101000000-abcdef123456',
    'v1.2.4-pre',
    'v1.2.4-pre.0.20210101000000-abcdef123456',
    'v1.2.4',
    'v2.0.0+incompatible',
    'v2.1.0+incompatible'
  ]],
  ['PyPI', [
    '1.0.dev1',
    '1.0a1.dev1',
    '1.0a1',
    '1.0a2',
    '1.0b1',
    '1.0rc1',
    '1.0',
    '1.0+abc',
    '1.0+1',
    '1.0+1.abc',
    '1.0+10',
    '1.0.post1.dev1',
    '1.0.post1',
    '1.0.1',
    '1.10',
    '2024.1',
    '1!0.1'
  ]],
  ['RubyGems', ['1.0.0.a', '1.0.0.b1', '1.0.0.pre', '1.0.0.rc1', '1.0.0.rc2', '1.0.0', '1.0.1', '1.9', '1.10', '2.0.0.beta', '2.0.0']],
  ['Packagist', ['1.0.0-dev', '1.0.0-alpha1', '1.0.0-beta1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-RC1', '1.0.0', '1.0.0-patch1', '1.0.1', 'v1.10.0', '2.1.5', '2.1.x-dev', '2.2.0']]
]

describe('comparing versions', () => {
  it.each(ascending)('orders %s versions', (ecosystem, versions) => {
    for (let lower = 0; lower < versions.length; lower++) {
      for (let higher = lower + 1; higher < versions.length; higher++) {
        expect(compareVersions(ecosystem, versions[lower], versions[higher]), `${versions[lower]} < ${versions[higher]}`).toBeLessThan(0)
        expect(compareVersions(ecosystem, versions[higher], versions[lower]), `${versions[higher]} > ${versions[lower]}`).toBeGreaterThan(0)
      }
    }
  })

  it.each([
    ['npm', '1.0.0+build.1', '1.0.0+build.2'],
    ['npm', 'v1.2.3', '1.2.3'],
    ['crates.io', '1.0.0-beta+exp.sha.5114f85', '1.0.0-beta'],
    ['Go', 'v1.2.3', '1.2.3'],
    ['Go', 'v2.0.0+incompatible', 'v2.0.0'],
    ['Go', 'v1', 'v1.0.0'],
    ['PyPI', '1.0.0', '1'],
    ['PyPI', '1.0ALPHA1', '1.0a1'],
    ['PyPI', '1.0-preview.2', '1.0rc2'],
    ['PyPI', '1.0c1', '1.0rc1'],
    ['PyPI', '1.0-1', '1.0.post1'],
    ['PyPI', '1.0_rev3', '1.0.post3'],
    ['PyPI', '1.0.dev', '1.0.dev0'],
    ['PyPI', 'v1.0', '1.0'],
    ['PyPI', '0!3.0', '3.0'],
    ['PyPI', '1.0+ubuntu-1', '1.0+ubuntu.1'],
    ['RubyGems', '1.0', '1.0.0'],
    ['RubyGems', '1.0.0.rc.1', '1.0.0.rc1'],
    ['RubyGems', '1.0-1', '1.0.pre.1'],
    ['Packagist', 'v2.0.0', '2.0.0'],
    ['Packagist', '2.0', '2.0.0.0'],
    ['Packagist', '1.0.0-b2', '1.0.0-beta2'],
    ['Packagist', '1.0.0-rc.1', '1.0.0-RC1'],
    ['Packagist', '1.0.0-a1', '1.0.0-alpha1']
  ] as [Ecosystem, string, string][])('treats %s %s and %s as equal', (ecosystem, a, b) => {
    expect(compareVersions(ecosystem, a, b)).toBe(0)
    expect(compareVersions(ecosystem, b, a)).toBe(0)
  })

  it('compares versions no scheme accepts by their numbers', () => {
    expect(compareVersions('npm', '1.2.3.4', '1.2.3.10')).toBeLessThan(0)
    expect(compareVersions('Packagist', 'dev-main', 'dev-main')).toBe(0)
    expect(compareVersions('Go', 'not a version', 'not a version')).toBe(0)
  })

  it('never throws on odd input', () => {
    const odd = ['', ' ', 'latest', '*', '^1.2.3', '>=1.0, <2.0', '1..2', '-1', '9'.repeat(400), '1.0.0-', 'v', '!', '1!']
    const ecosystems: Ecosystem[] = ['npm', 'crates.io', 'Go', 'PyPI', 'RubyGems', 'Packagist']
    for (const ecosystem of ecosystems) {
      for (const a of odd) {
        for (const b of [...odd, '1.0.0']) {
          expect(() => compareVersions(ecosystem, a, b)).not.toThrow()
          expect(() => updateKind(ecosystem, a, b)).not.toThrow()
        }
        expect(() => isPrerelease(ecosystem, a)).not.toThrow()
      }
    }
  })

  it('orders numbers beyond the safe integer range exactly', () => {
    expect(compareVersions('npm', '1.0.9007199254740993', '1.0.9007199254740992')).toBeGreaterThan(0)
  })
})

describe('pre-releases', () => {
  it.each([
    ['npm', '1.0.0-rc.1', true],
    ['npm', '1.0.0+build.5', false],
    ['npm', '1.0.0', false],
    ['Go', 'v0.0.0-20210101000000-abcdef123456', true],
    ['Go', 'v2.0.0+incompatible', false],
    ['PyPI', '1.0.dev1', true],
    ['PyPI', '1.0a1', true],
    ['PyPI', '1.0RC2', true],
    ['PyPI', '1.0.post1', false],
    ['PyPI', '1.0+local', false],
    ['RubyGems', '1.0.0.rc1', true],
    ['RubyGems', '1.0-1', true],
    ['RubyGems', '1.0.0', false],
    ['Packagist', '1.0.0-beta1', true],
    ['Packagist', '1.0.0-RC1', true],
    ['Packagist', '2.1.x-dev', true],
    ['Packagist', '1.0.0-patch1', false],
    ['Packagist', 'v1.0.0', false],
    ['npm', 'latest', false]
  ] as [Ecosystem, string, boolean][])('in %s reads %s as %s', (ecosystem, version, expected) => {
    expect(isPrerelease(ecosystem, version)).toBe(expected)
  })
})

describe('size of an update', () => {
  it.each([
    ['npm', '1.2.3', '2.0.0', 'major'],
    ['npm', '0.3.1', '0.4.0', 'major'],
    ['npm', '0.0.3', '0.0.4', 'major'],
    ['npm', '0.3.1', '1.0.0', 'major'],
    ['npm', '0.0.0', '0.0.1', 'major'],
    ['npm', '2.0.0', '1.9.9', 'major'],
    ['npm', '1.2.3', '1.3.0', 'minor'],
    ['npm', '1.2.3', '1.2.4', 'patch'],
    ['npm', '0.3.1', '0.3.2', 'patch'],
    ['npm', '1.0.0-beta.1', '1.0.0', 'patch'],
    ['Go', 'v1.2.3', 'v1.2.4-0.20210101000000-abcdef123456', 'patch'],
    ['Go', 'v1.9.0', 'v1.10.0', 'minor'],
    ['PyPI', '2.0', '1!1.0', 'major'],
    ['PyPI', '2.0', '2.1', 'minor'],
    ['PyPI', '2.0', '2.0.post1', 'patch'],
    ['RubyGems', '7.0.8', '7.1.0', 'minor'],
    ['RubyGems', '7.1.0.rc1', '7.1.0', 'patch'],
    ['Packagist', 'v5.4.21', 'v6.0.0', 'major'],
    ['Packagist', '1.2.3.4', '1.2.3.5', 'patch'],
    ['crates.io', '0.11.22', '0.12.0', 'major'],
    ['npm', '1.2.3.4', '1.3.0.0', 'minor'],
    ['npm', 'latest', 'next', 'major']
  ] as [Ecosystem, string, string, string][])('in %s calls %s to %s %s', (ecosystem, from, to, kind) => {
    expect(updateKind(ecosystem, from, to)).toBe(kind)
  })
})
