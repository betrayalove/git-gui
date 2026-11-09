import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cvssScore, severityOfScore } from '../shared/cvss'
import { advisoryKey, statusKey, type Advisory, type DependencyReport, type Ecosystem, type LockedPackage, type PackageStatus, type RuntimeSupport, type Severity } from '../shared/deps'
import { t } from '../shared/i18n'
import { compareVersions } from '../shared/versions'
import { gitLine } from './git'
import { readLockfiles } from './lockfiles'

/** Where the public databases live. Tests point all three at one local server. */
export interface Sources {
  osv: string
  depsDev: string
  endOfLife: string
}

export const PUBLIC_SOURCES: Sources = {
  osv: 'https://api.osv.dev',
  depsDev: 'https://api.deps.dev',
  endOfLife: 'https://endoflife.date'
}

const TIMEOUT_MS = 30_000
const BATCH = 1000
const PARALLEL = 8
const DAY_MS = 24 * 60 * 60 * 1000

const DEPS_DEV_SYSTEM: Partial<Record<Ecosystem, string>> = {
  npm: 'npm', PyPI: 'pypi', Go: 'go', 'crates.io': 'cargo', RubyGems: 'rubygems'
}

/** Packages whose major versions have a published end of support, by the name endoflife.date uses. */
const RUNTIMES: Partial<Record<Ecosystem, Record<string, string>>> = {
  npm: { electron: 'electron', react: 'react', vue: 'vue', '@angular/core': 'angular', next: 'nextjs', nuxt: 'nuxt' },
  PyPI: { django: 'django', flask: 'flask' },
  RubyGems: { rails: 'rails' },
  Packagist: { 'laravel/framework': 'laravel', 'symfony/http-kernel': 'symfony' }
}

const GITHUB_SEVERITY: Record<string, Severity> = { LOW: 'low', MODERATE: 'moderate', MEDIUM: 'moderate', HIGH: 'high', CRITICAL: 'critical' }

interface OsvVulnerability {
  id: string
  modified: string
  published?: string
  withdrawn?: string
  summary?: string
  details?: string
  aliases?: string[]
  severity?: { type: string; score: string }[]
  database_specific?: { severity?: string }
  affected?: {
    package?: { name: string; ecosystem: string }
    ranges?: { type: string; events: Record<string, string>[] }[]
    versions?: string[]
  }[]
}

async function getJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Chronicle' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(t('{host} ответил ошибкой {status}', { host: new URL(url).host, status: response.status }))
  return (await response.json()) as T
}

/** Runs the tasks a few at a time, so a big project does not open hundreds of connections. */
async function inParallel<T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
  return results
}

/** A small JSON cache on disk, keyed by text. */
function cache(folder: string): { read<T>(key: string): Promise<T | null>; write(key: string, value: unknown): Promise<void> } {
  const path = (key: string): string => join(folder, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
  return {
    read: async <T>(key: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(path(key), 'utf8')) as T
      } catch {
        return null
      }
    },
    write: async (key: string, value: unknown): Promise<void> => {
      await mkdir(folder, { recursive: true })
      await writeFile(path(key), JSON.stringify(value))
    }
  }
}

/** The lowest fixed version of the range that contains `version`, or past it when ranges do not say. */
function fixedVersion(vulnerability: OsvVulnerability, ecosystem: Ecosystem, name: string, version: string): string | null {
  const compare = (a: string, b: string): number => compareVersions(ecosystem, a, b)
  const fixes: string[] = []
  for (const affected of vulnerability.affected ?? []) {
    if (affected.package && (affected.package.ecosystem !== ecosystem || affected.package.name !== name)) continue
    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') continue
      let introduced: string | null = null
      for (const event of range.events) {
        if (event.introduced !== undefined) introduced = event.introduced
        const fixed = event.fixed
        if (fixed === undefined) continue
        const inside = (introduced === null || introduced === '0' || compare(introduced, version) <= 0) && compare(version, fixed) < 0
        if (inside) return fixed
        if (compare(fixed, version) > 0) fixes.push(fixed)
      }
    }
  }
  return fixes.sort(compare)[0] ?? null
}

/** OSV writes Go versions without the `v` that go.mod and the go command use. */
function spellLike(version: string, fixed: string | null): string | null {
  return fixed && version.startsWith('v') && /^\d/.test(fixed) ? `v${fixed}` : fixed
}

function toAdvisory(vulnerability: OsvVulnerability, ecosystem: Ecosystem, name: string, version: string): Advisory {
  const vectors = (vulnerability.severity ?? []).map((item) => cvssScore(item.score)).filter((score) => score !== null)
  const score = vectors.length ? Math.max(...vectors) : null
  const labelled = GITHUB_SEVERITY[vulnerability.database_specific?.severity?.toUpperCase() ?? '']
  const ids = [vulnerability.id, ...(vulnerability.aliases ?? [])]
  const primary = ids.find((id) => id.startsWith('GHSA-')) ?? vulnerability.id
  return {
    id: primary,
    aliases: ids.filter((id) => id !== primary),
    summary: vulnerability.summary || vulnerability.details?.split('\n')[0] || '',
    // A malicious package is the worst case whatever the scores say: installing it already ran its code.
    severity: vulnerability.id.startsWith('MAL-') ? 'critical' : labelled ?? (score === null ? 'unknown' : severityOfScore(score)),
    score,
    fixed: spellLike(version, fixedVersion(vulnerability, ecosystem, name, version)),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(vulnerability.id)}`,
    published: vulnerability.published ?? vulnerability.modified
  }
}

/** The same flaw is often filed in several databases. They share an ID through aliases. */
function mergeDuplicates(advisories: Advisory[]): Advisory[] {
  const kept: Advisory[] = []
  for (const advisory of advisories) {
    const names = new Set([advisory.id, ...advisory.aliases])
    const twin = kept.find((item) => names.has(item.id) || item.aliases.some((alias) => names.has(alias)))
    if (!twin) {
      kept.push(advisory)
      continue
    }
    twin.aliases = [...new Set([...twin.aliases, ...names])].filter((id) => id !== twin.id)
    if (twin.severity === 'unknown') twin.severity = advisory.severity
    twin.score ??= advisory.score
    twin.fixed ??= advisory.fixed
  }
  return kept
}

interface PackageRef {
  ecosystem: Ecosystem
  name: string
  version: string
}

async function findAdvisories(packages: PackageRef[], sources: Sources, store: ReturnType<typeof cache>): Promise<Record<string, Advisory[]>> {
  const found: { item: PackageRef; vulns: { id: string; modified: string }[] }[] = []
  for (let start = 0; start < packages.length; start += BATCH) {
    const slice = packages.slice(start, start + BATCH)
    const reply = await getJson<{ results: { vulns?: { id: string; modified: string }[] }[] }>(`${sources.osv}/v1/querybatch`, {
      queries: slice.map((item) => ({ package: { name: item.name, ecosystem: item.ecosystem }, version: item.version }))
    })
    reply.results.forEach((result, index) => {
      if (result.vulns?.length) found.push({ item: slice[index], vulns: result.vulns })
    })
  }
  const wanted = new Map(found.flatMap(({ vulns }) => vulns.map((vuln) => [vuln.id, vuln.modified])))
  const details = new Map<string, OsvVulnerability>()
  await inParallel([...wanted], async ([id, modified]) => {
    const cached = await store.read<OsvVulnerability>(`osv:${id}`)
    if (cached && cached.modified === modified) {
      details.set(id, cached)
      return
    }
    const fresh = await getJson<OsvVulnerability>(`${sources.osv}/v1/vulns/${encodeURIComponent(id)}`)
    await store.write(`osv:${id}`, fresh)
    details.set(id, fresh)
  })
  const advisories: Record<string, Advisory[]> = {}
  for (const { item, vulns } of found) {
    // A withdrawn advisory turned out to be a mistake.
    const list = vulns.map((vuln) => details.get(vuln.id)).filter((vuln): vuln is OsvVulnerability => vuln !== undefined && !vuln.withdrawn)
      .map((vuln) => toAdvisory(vuln, item.ecosystem, item.name, item.version))
    if (list.length) advisories[advisoryKey(item.ecosystem, item.name, item.version)] = mergeDuplicates(list)
  }
  return advisories
}

interface DepsDevPackage {
  versions?: { versionKey: { version: string }; isDefault?: boolean; isDeprecated?: boolean; deprecatedReason?: string }[]
}

async function packageStatus(item: PackageRef, sources: Sources, store: ReturnType<typeof cache>): Promise<PackageStatus | null> {
  const system = DEPS_DEV_SYSTEM[item.ecosystem]
  if (!system) return null
  const key = `deps.dev:${system}:${item.name}`
  let reply = await store.read<DepsDevPackage & { at: number }>(key)
  if (!reply || Date.now() - reply.at > DAY_MS) {
    try {
      reply = { ...(await getJson<DepsDevPackage>(`${sources.depsDev}/v3/systems/${system}/packages/${encodeURIComponent(item.name)}`)), at: Date.now() }
    } catch {
      // A package deps.dev does not know yet is not a reason to fail the whole check.
      return null
    }
    await store.write(key, reply)
  }
  const versions = reply.versions ?? []
  const current = versions.find((entry) => entry.versionKey.version === item.version)
  return {
    latest: versions.find((entry) => entry.isDefault)?.versionKey.version ?? null,
    deprecated: current?.isDeprecated ? current.deprecatedReason || t('Автор пометил эту версию устаревшей') : null
  }
}

interface EndOfLifeProduct {
  result?: { releases?: { name: string; isEol?: boolean; eolFrom?: string | null; latest?: { name?: string } | null }[] }
}

async function runtimeSupport(product: string, version: string, sources: Sources, store: ReturnType<typeof cache>): Promise<RuntimeSupport | null> {
  const key = `endoflife:${product}`
  let reply = await store.read<EndOfLifeProduct & { at: number }>(key)
  if (!reply || Date.now() - reply.at > DAY_MS) {
    try {
      reply = { ...(await getJson<EndOfLifeProduct>(`${sources.endOfLife}/api/v1/products/${encodeURIComponent(product)}/`)), at: Date.now() }
    } catch {
      return null
    }
    await store.write(key, reply)
  }
  // A release line is named by its major, or major and minor, version: `45` or `5.0`.
  const release = (reply.result?.releases ?? [])
    .filter((item) => version === item.name || version.startsWith(`${item.name}.`))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (!release) return null
  return { product, version, eol: release.eolFrom ?? null, isEol: Boolean(release.isEol), latest: release.latest?.name ?? null }
}

/**
 * Reads the lockfiles of a commit and asks public databases about every package in them. Only
 * names and versions of public packages leave the computer.
 */
export async function checkDependencies(cwd: string, options: { rev?: string; cacheDir: string; sources?: Sources }): Promise<DependencyReport> {
  const sources = options.sources ?? PUBLIC_SOURCES
  const store = cache(join(options.cacheDir, 'cache'))
  const rev = options.rev ?? 'HEAD'
  const commit = await gitLine(cwd, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])
  const { lockfiles, skipped } = await readLockfiles(cwd, commit)
  const unique = new Map<string, PackageRef & { item: LockedPackage }>()
  for (const lockfile of lockfiles) {
    for (const item of lockfile.packages) {
      const key = advisoryKey(lockfile.ecosystem, item.name, item.version)
      if (!unique.has(key)) unique.set(key, { ecosystem: lockfile.ecosystem, name: item.name, version: item.version, item })
    }
  }
  const advisories = await findAdvisories([...unique.values()], sources, store)
  // Registry status matters for what the project chose itself and for what needs a fix.
  const asked = [...unique.entries()].filter(([key, entry]) => entry.item.direct || advisories[key])
  const packages: Record<string, PackageStatus> = {}
  await inParallel(asked, async ([, entry]) => {
    const status = await packageStatus(entry, sources, store)
    if (status) packages[statusKey(entry.ecosystem, entry.name)] = status
  })
  const runtimeRefs = [...unique.values()].filter((entry) => entry.item.direct && RUNTIMES[entry.ecosystem]?.[entry.name])
  const runtimes = (await inParallel(runtimeRefs, (entry) => runtimeSupport(RUNTIMES[entry.ecosystem]![entry.name], entry.version, sources, store)))
    .filter((item) => item !== null)
  const report: DependencyReport = { commit, checkedAt: new Date().toISOString(), lockfiles, advisories, packages, runtimes, skipped }
  await cache(options.cacheDir).write(`report:${cwd}`, report)
  return report
}

/** The last report for a repository, to show at once and when the network is down. */
export function lastDependencyReport(cwd: string, cacheDir: string): Promise<DependencyReport | null> {
  return cache(cacheDir).read<DependencyReport>(`report:${cwd}`)
}
