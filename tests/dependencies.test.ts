import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkDependencies, lastDependencyReport, type Sources } from '../src/core/dependencies'
import { adviseDependencies } from '../src/shared/advice'
import { commitFile, createRepo, tempDir } from './helpers'

const FIXTURES = join(__dirname, 'fixtures', 'lockfiles')

/** What a vulnerability in `ms` looks like in OSV, filed twice under different IDs. */
const MS_VULNS = {
  'GHSA-w9mr-4mfr-499f': {
    id: 'GHSA-w9mr-4mfr-499f', modified: '2024-01-01T00:00:00Z', published: '2017-10-24T18:33:36Z',
    summary: 'Vercel ms Inefficient Regular Expression Complexity vulnerability', aliases: ['CVE-2017-20162'],
    database_specific: { severity: 'MODERATE' },
    affected: [{ package: { name: 'ms', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.1.1' }] }] }]
  },
  'OSV-ms-copy': {
    id: 'OSV-ms-copy', modified: '2024-01-01T00:00:00Z', aliases: ['CVE-2017-20162'],
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
    affected: [{ package: { name: 'ms', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.1.1' }] }] }]
  },
  'GO-net': {
    id: 'GO-net', modified: '2024-01-01T00:00:00Z', summary: 'Excessive memory use in golang.org/x/net',
    affected: [{ package: { name: 'golang.org/x/net', ecosystem: 'Go' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.62.0' }] }] }]
  },
  'GHSA-withdrawn': {
    id: 'GHSA-withdrawn', modified: '2024-01-01T00:00:00Z', withdrawn: '2024-02-01T00:00:00Z', summary: 'Filed by mistake',
    affected: [{ package: { name: 'golang.org/x/text', ecosystem: 'Go' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.41.0' }] }] }]
  },
  'MAL-2024-1': {
    id: 'MAL-2024-1', modified: '2024-01-01T00:00:00Z', summary: 'Malicious code in github.com/evil/kit',
    affected: [{ package: { name: 'github.com/evil/kit', ecosystem: 'Go' }, versions: ['v1.0.0'] }]
  },
  'GHSA-debug': {
    id: 'GHSA-debug', modified: '2024-01-01T00:00:00Z', summary: 'Regular Expression Denial of Service in debug',
    database_specific: { severity: 'HIGH' },
    affected: [{ package: { name: 'debug', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.6.9' }, { introduced: '3.0.0' }, { fixed: '3.1.0' }] }] }]
  }
}

describe('checking dependencies', () => {
  let server: Server
  let sources: Sources
  const queries: unknown[] = []
  const paths: string[] = []

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        paths.push(request.url ?? '')
        const send = (status: number, value: unknown): void => {
          response.writeHead(status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        const url = request.url ?? ''
        if (url === '/v1/querybatch') {
          const { queries: list } = JSON.parse(body) as { queries: { package: { name: string }; version: string }[] }
          queries.push(...list)
          return send(200, {
            results: list.map((query) => {
              if (query.package.name === 'ms') return { vulns: [{ id: 'GHSA-w9mr-4mfr-499f', modified: '2024-01-01T00:00:00Z' }, { id: 'OSV-ms-copy', modified: '2024-01-01T00:00:00Z' }] }
              if (query.package.name === 'debug') return { vulns: [{ id: 'GHSA-debug', modified: '2024-01-01T00:00:00Z' }] }
              if (query.package.name === 'golang.org/x/net') return { vulns: [{ id: 'GO-net', modified: '2024-01-01T00:00:00Z' }] }
              if (query.package.name === 'golang.org/x/text') return { vulns: [{ id: 'GHSA-withdrawn', modified: '2024-01-01T00:00:00Z' }] }
              if (query.package.name === 'github.com/evil/kit') return { vulns: [{ id: 'MAL-2024-1', modified: '2024-01-01T00:00:00Z' }] }
              return {}
            })
          })
        }
        const vuln = /^\/v1\/vulns\/(.+)$/.exec(url)
        if (vuln) return send(200, MS_VULNS[decodeURIComponent(vuln[1]) as keyof typeof MS_VULNS])
        const pkg = /^\/v3\/systems\/npm\/packages\/(.+)$/.exec(url)
        if (pkg) {
          const name = decodeURIComponent(pkg[1])
          const versions: Record<string, { version: string; isDefault?: boolean; isDeprecated?: boolean; deprecatedReason?: string }[]> = {
            lodash: [{ version: '4.18.1', isDefault: true }],
            minimist: [{ version: '1.2.0' }, { version: '1.2.8', isDefault: true }],
            '@sindresorhus/is': [{ version: '0.14.0', isDeprecated: true, deprecatedReason: 'Use v4' }, { version: '7.0.1', isDefault: true }],
            debug: [{ version: '2.6.8' }, { version: '4.4.0', isDefault: true }],
            ms: [{ version: '2.0.0' }, { version: '2.1.3', isDefault: true }]
          }
          if (!versions[name]) return send(404, {})
          return send(200, { versions: versions[name].map((item) => ({ ...item, versionKey: { version: item.version } })) })
        }
        if (url === '/api/v1/products/electron/') {
          return send(200, { result: { releases: [{ name: '45', isEol: false, eolFrom: '2027-04-27', latest: { name: '45.2.3' } }, { name: '30', isEol: true, eolFrom: '2024-10-15', latest: { name: '30.5.1' } }] } })
        }
        send(404, {})
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    sources = { osv: base, depsDev: base, endOfLife: base }
  })
  afterAll(() => { server.close() })

  it('reports vulnerabilities, registry status and advice for a commit', async () => {
    const repo = await createRepo()
    await commitFile(repo, 'package-lock.json', readFileSync(join(FIXTURES, 'package-lock.json'), 'utf8'), 'Add lockfile')
    const cacheDir = tempDir()
    const report = await checkDependencies(repo, { cacheDir, sources })

    // Only package names and versions leave the computer.
    expect(queries).toContainEqual({ package: { name: 'ms', ecosystem: 'npm' }, version: '2.0.0' })
    expect(queries.every((query) => JSON.stringify(Object.keys(query as object)) === '["package","version"]')).toBe(true)

    const ms = report.advisories['npm:ms@2.0.0']
    expect(ms).toHaveLength(1)
    expect(ms[0]).toMatchObject({ id: 'GHSA-w9mr-4mfr-499f', severity: 'moderate', aliases: expect.arrayContaining(['CVE-2017-20162', 'OSV-ms-copy']) })
    expect(report.advisories['npm:debug@2.6.8'][0]).toMatchObject({ severity: 'high', fixed: '2.6.9' })
    expect(report.packages['npm:@sindresorhus/is']).toEqual({ latest: '7.0.1', deprecated: 'Use v4' })

    const advice = adviseDependencies(report)
    expect(advice.map((item) => [item.group, item.name, item.target])).toEqual([
      ['urgent', 'debug', '2.6.9'],
      ['recommended', 'ms', '2.1.1'],
      ['recommended', '@sindresorhus/is', '7.0.1'],
      ['safe', 'minimist', '1.2.8']
    ])
    expect(advice.find((item) => item.name === 'ms')?.via).toEqual(['debug', 'ms'])

    expect(await lastDependencyReport(repo, cacheDir)).toEqual(report)
  })

  it('reads a vulnerability once and then from the cache', async () => {
    const repo = await createRepo()
    await commitFile(repo, 'package-lock.json', readFileSync(join(FIXTURES, 'package-lock.json'), 'utf8'), 'Add lockfile')
    const cacheDir = tempDir()
    await checkDependencies(repo, { cacheDir, sources })
    paths.length = 0
    await checkDependencies(repo, { cacheDir, sources })
    expect(paths.filter((path) => path.startsWith('/v1/vulns/'))).toEqual([])
  })

  it('reports how long a framework is supported', async () => {
    const repo = await createRepo()
    const lock = { lockfileVersion: 3, packages: { '': { devDependencies: { electron: '^30.0.0' } }, 'node_modules/electron': { version: '30.1.0', dev: true, resolved: 'https://registry.npmjs.org/electron/-/electron-30.1.0.tgz' } } }
    await commitFile(repo, 'package-lock.json', JSON.stringify(lock), 'Add Electron')
    const report = await checkDependencies(repo, { cacheDir: tempDir(), sources })
    expect(report.runtimes).toEqual([{ product: 'electron', version: '30.1.0', eol: '2024-10-15', isEol: true, latest: '30.5.1' }])
  })

  it('spells Go fixes as go.mod does, skips withdrawn advisories and puts malware first', async () => {
    const repo = await createRepo()
    const goMod = 'module example.com/app\n\ngo 1.24\n\nrequire (\n\tgithub.com/evil/kit v1.0.0 // indirect\n\tgolang.org/x/net v0.56.0\n\tgolang.org/x/text v0.39.0\n)\n'
    await commitFile(repo, 'go.mod', goMod, 'Add module')
    const report = await checkDependencies(repo, { cacheDir: tempDir(), sources })
    expect(report.advisories['Go:golang.org/x/net@v0.56.0'][0].fixed).toBe('v0.62.0')
    expect(report.advisories['Go:golang.org/x/text@v0.39.0']).toBeUndefined()
    expect(adviseDependencies(report).filter((item) => item.advisories.length).map((item) => [item.group, item.name, item.target, item.advisories[0].severity])).toEqual([
      ['urgent', 'github.com/evil/kit', null, 'critical'],
      ['recommended', 'golang.org/x/net', 'v0.62.0', 'unknown']
    ])
  })

  it('fails with the server named when a database is down', async () => {
    const repo = await createRepo()
    await commitFile(repo, 'package-lock.json', readFileSync(join(FIXTURES, 'package-lock.json'), 'utf8'), 'Add lockfile')
    const broken = { ...sources, osv: `${sources.osv}/broken` }
    await expect(checkDependencies(repo, { cacheDir: tempDir(), sources: broken })).rejects.toThrow('127.0.0.1')
  })
})
