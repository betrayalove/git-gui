import { advisoryKey, packageKey, statusKey, type Advisory, type DependencyReport, type Ecosystem, type Lockfile, type LockedPackage, type PackageManager, type Severity } from './deps'
import { compareVersions, updateKind } from './versions'

/**
 * - `urgent`: a malicious package, or a serious vulnerability in code that ships with a fix available.
 * - `recommended`: a vulnerability that matters less, or a package its author abandoned.
 * - `unfixed`: a vulnerability nobody has fixed yet.
 * - `major`: a newer major version, which may need code changes.
 * - `safe`: a newer version that should not break anything.
 */
export type AdviceGroup = 'urgent' | 'recommended' | 'unfixed' | 'major' | 'safe'

export const ADVICE_ORDER: AdviceGroup[] = ['urgent', 'recommended', 'unfixed', 'major', 'safe']

export interface Advice {
  group: AdviceGroup
  lockfile: string
  ecosystem: Ecosystem
  manager: PackageManager
  name: string
  version: string
  /** The version to move to, or null when there is none to suggest. */
  target: string | null
  direct: boolean
  dev: boolean
  advisories: Advisory[]
  deprecated: string | null
  /** How the project gets the package: names from a direct dependency down to it. */
  via: string[]
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, moderate: 2, low: 1, unknown: 0 }

/** A package published to do harm, as OSV files them under `MAL-`. */
export function isMalicious(advisories: Advisory[]): boolean {
  return advisories.some((advisory) => advisory.id.startsWith('MAL-'))
}

export function worstSeverity(advisories: Advisory[]): Severity {
  return advisories.reduce<Severity>((worst, item) => (SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst] ? item.severity : worst), 'unknown')
}

/** The shortest chain of package names from a direct dependency to each package. */
function chains(packages: LockedPackage[]): Map<string, string[]> {
  const byKey = new Map(packages.map((item) => [packageKey(item.name, item.version), item]))
  const paths = new Map<string, string[]>()
  const queue = packages.filter((item) => item.direct).map((item) => packageKey(item.name, item.version))
  for (const key of queue) paths.set(key, [byKey.get(key)!.name])
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index]
    for (const next of byKey.get(key)?.dependencies ?? []) {
      if (paths.has(next) || !byKey.has(next)) continue
      paths.set(next, [...paths.get(key)!, byKey.get(next)!.name])
      queue.push(next)
    }
  }
  return paths
}

function adviseLockfile(lockfile: Lockfile, report: DependencyReport): Advice[] {
  const { ecosystem } = lockfile
  const compare = (a: string, b: string): number => compareVersions(ecosystem, a, b)
  const paths = chains(lockfile.packages)
  const advice: Advice[] = []
  for (const item of lockfile.packages) {
    const advisories = report.advisories[advisoryKey(ecosystem, item.name, item.version)] ?? []
    const status = report.packages[statusKey(ecosystem, item.name)]
    const base = {
      lockfile: lockfile.path, ecosystem, manager: lockfile.manager, name: item.name, version: item.version,
      direct: item.direct, dev: item.dev, advisories, deprecated: status?.deprecated ?? null,
      via: paths.get(packageKey(item.name, item.version)) ?? [item.name]
    }
    if (advisories.length) {
      const fixes = advisories.map((advisory) => advisory.fixed).filter((fixed) => fixed !== null).sort(compare)
      const target = fixes.at(-1) ?? null
      const serious = SEVERITY_RANK[worstSeverity(advisories)] >= SEVERITY_RANK.high
      const group = isMalicious(advisories) ? 'urgent' : !target ? 'unfixed' : serious && !item.dev ? 'urgent' : 'recommended'
      advice.push({ ...base, target, group })
      continue
    }
    if (!item.direct) continue
    const latest = status?.latest && compare(status.latest, item.version) > 0 ? status.latest : null
    if (base.deprecated) advice.push({ ...base, target: latest, group: 'recommended' })
    else if (latest) advice.push({ ...base, target: latest, group: updateKind(ecosystem, item.version, latest) === 'major' ? 'major' : 'safe' })
  }
  return advice
}

const PACKAGE_PAGES: Record<Ecosystem, (name: string) => string> = {
  npm: (name) => `https://www.npmjs.com/package/${name}`,
  PyPI: (name) => `https://pypi.org/project/${name}/`,
  Go: (name) => `https://pkg.go.dev/${name}`,
  'crates.io': (name) => `https://crates.io/crates/${name}`,
  RubyGems: (name) => `https://rubygems.org/gems/${name}`,
  Packagist: (name) => `https://packagist.org/packages/${name}`
}

/** The package's page in its registry, with its versions and changelog links. */
export function packagePage(ecosystem: Ecosystem, name: string): string | null {
  return /^[\w@./-]+$/.test(name) ? PACKAGE_PAGES[ecosystem](name) : null
}

/** What to update and why, most pressing first. */
export function adviseDependencies(report: DependencyReport): Advice[] {
  return report.lockfiles.flatMap((lockfile) => adviseLockfile(lockfile, report)).sort((a, b) =>
    ADVICE_ORDER.indexOf(a.group) - ADVICE_ORDER.indexOf(b.group) ||
    SEVERITY_RANK[worstSeverity(b.advisories)] - SEVERITY_RANK[worstSeverity(a.advisories)] ||
    Number(a.dev) - Number(b.dev) ||
    a.name.localeCompare(b.name))
}
