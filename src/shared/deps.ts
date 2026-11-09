/** Ecosystem names as OSV.dev spells them. */
export type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems' | 'Packagist'

/** The tool that writes a lockfile, which is also the one that can update it. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'cargo' | 'go' | 'poetry' | 'uv' | 'pip' | 'pipenv' | 'bundler' | 'composer'

export interface LockedPackage {
  name: string
  version: string
  /** Listed by the project itself rather than pulled in by another package. */
  direct: boolean
  /** Needed only to build or test the project, so it does not ship with it. */
  dev: boolean
  /** Keys of the packages this one needs, as made by `packageKey`. */
  dependencies: string[]
}

export interface Lockfile {
  /** Path inside the repository, with forward slashes. */
  path: string
  ecosystem: Ecosystem
  manager: PackageManager
  packages: LockedPackage[]
}

/** How to read one kind of lockfile. */
export interface LockfileFormat {
  /** The file name it is recognized by. */
  file: string
  ecosystem: Ecosystem
  manager: PackageManager
  /** A file next to the lockfile that says which packages are direct, when the lockfile does not. */
  manifest?: string
  /**
   * Reads the packages from a public registry. Local, git and private packages are left out, because
   * their names must not leave the computer and no public database knows them.
   * Throws when the text is not this format.
   */
  parse(text: string, manifest: string | null): LockedPackage[]
}

export function packageKey(name: string, version: string): string {
  return `${name}@${version}`
}

/**
 * Marks as dev every package that no direct runtime dependency reaches. Parsers set `direct` and,
 * for direct packages, `dev`; this works out the rest from the dependency edges.
 */
export function settleDev(packages: LockedPackage[]): LockedPackage[] {
  const byKey = new Map(packages.map((item) => [packageKey(item.name, item.version), item]))
  const runtime = new Set<string>()
  const stack = packages.filter((item) => item.direct && !item.dev).map((item) => packageKey(item.name, item.version))
  while (stack.length) {
    const key = stack.pop()!
    if (runtime.has(key)) continue
    runtime.add(key)
    stack.push(...(byKey.get(key)?.dependencies ?? []))
  }
  return packages.map((item) => ({ ...item, dev: !runtime.has(packageKey(item.name, item.version)) }))
}

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'

export interface Advisory {
  /** A GitHub advisory ID when there is one, since that is what people search for. */
  id: string
  aliases: string[]
  summary: string
  severity: Severity
  /** CVSS base score, when the advisory has a vector that can be scored. */
  score: number | null
  /** The lowest version past the one in use that no longer has it. Null when no fix exists. */
  fixed: string | null
  url: string
  published: string
}

export interface PackageStatus {
  /** The version the registry offers by default. */
  latest: string | null
  /** Why the author asks people to stop using the version in use. */
  deprecated: string | null
}

export interface RuntimeSupport {
  /** Such as `electron` or `nodejs`, as endoflife.date names it. */
  product: string
  version: string
  /** The date support ends, or ended. */
  eol: string | null
  isEol: boolean
  latest: string | null
}

export interface DependencyReport {
  /** The commit whose lockfiles were read. */
  commit: string
  checkedAt: string
  lockfiles: Lockfile[]
  /** Advisories by `ecosystem:name@version`. */
  advisories: Record<string, Advisory[]>
  /** Registry status by `ecosystem:name`, for direct dependencies and vulnerable packages. */
  packages: Record<string, PackageStatus>
  runtimes: RuntimeSupport[]
  /** Lockfiles that could not be read, with the reason. */
  skipped: { path: string; reason: string }[]
}

/** A change to one lockfile that the app can make on a branch of its own. */
export interface DependencyFix {
  lockfile: string
  manager: PackageManager
  updates: { name: string; from: string; to: string; direct: boolean }[]
}

export interface FixResult {
  branch: string
  commit: string
  /** Every package whose version changed, including ones that moved along. */
  changed: { name: string; from: string | null; to: string | null }[]
  /** Updates that the package manager could not make, so the old version is still there. */
  missed: string[]
}
