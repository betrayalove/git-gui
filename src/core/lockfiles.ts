import { posix } from 'node:path'
import { packageKey, settleDev, type LockedPackage, type Lockfile, type LockfileFormat } from '../shared/deps'
import { t } from '../shared/i18n'
import { runGit } from './git'
import { MORE_FORMATS } from './lockfiles-more'
import { listFiles } from './read'

const PUBLIC_NPM = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//
const RELEASE = /^\d/

/** A package collected while reading, before edges are known to point at real entries. */
class Collector {
  private readonly packages = new Map<string, LockedPackage>()

  add(name: string, version: string, dependencies: string[] = [], direct = false): void {
    const key = packageKey(name, version)
    const known = this.packages.get(key)
    if (known) {
      known.dependencies = [...new Set([...known.dependencies, ...dependencies])]
      known.direct ||= direct
    } else {
      this.packages.set(key, { name, version, direct, dev: false, dependencies })
    }
  }

  /** Marks direct dependencies; a package any runtime section names stays runtime. */
  markDirect(name: string, version: string, dev: boolean): void {
    const item = this.packages.get(packageKey(name, version))
    if (!item) return
    item.dev = item.direct ? item.dev && dev : dev
    item.direct = true
  }

  finish(): LockedPackage[] {
    const keys = new Set(this.packages.keys())
    const list = [...this.packages.values()].map((item) => ({ ...item, dependencies: item.dependencies.filter((key) => keys.has(key)) }))
    return settleDev(list)
  }
}

/** The direct dependency sections of a package.json, runtime ones first. */
function manifestSections(text: string | null): { name: string; range: string; dev: boolean }[] {
  if (!text) return []
  const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>
  return (['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'] as const).flatMap((section) =>
    Object.entries(manifest[section] ?? {}).map(([name, range]) => ({ name, range, dev: section === 'devDependencies' })))
}

function parsePackageLock(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, NpmEntry> }
  if (!lock.packages) throw new Error(t('Старый формат package-lock.json. Обнови его командой npm install.'))
  const entries = lock.packages
  // Node looks for a package in node_modules next to the one that needs it, then in each folder above.
  const resolve = (from: string, name: string): string | null => {
    let base = from
    for (;;) {
      const candidate = `${base ? `${base}/` : ''}node_modules/${name}`
      if (entries[candidate]) return candidate
      if (!base) return null
      const index = base.lastIndexOf('node_modules/')
      base = index > 0 ? base.slice(0, index - 1) : ''
    }
  }
  const usable = (path: string): NpmEntry | null => {
    const entry = entries[path]
    if (!entry || entry.link || !entry.version || !RELEASE.test(entry.version)) return null
    if (entry.resolved && !PUBLIC_NPM.test(entry.resolved)) return null
    return entry
  }
  const nameOf = (path: string): string => entries[path].name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
  const keyOf = (path: string | null): string | null => {
    const entry = path ? usable(path) : null
    return entry ? packageKey(nameOf(path!), entry.version!) : null
  }
  const collector = new Collector()
  const sections = (entry: NpmEntry): { name: string; dev: boolean }[] => [
    ...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies }).map((name) => ({ name, dev: false })),
    ...Object.keys(entry.devDependencies ?? {}).map((name) => ({ name, dev: true }))
  ]
  for (const path of Object.keys(entries)) {
    const entry = usable(path)
    if (!entry || !path.includes('node_modules/')) continue
    const dependencies = sections(entry).filter((item) => !item.dev).map((item) => keyOf(resolve(path, item.name))).filter((key) => key !== null)
    collector.add(nameOf(path), entry.version!, dependencies)
  }
  // The root and workspace folders are the project itself: what they list is direct.
  for (const path of Object.keys(entries).filter((item) => !item.includes('node_modules/'))) {
    for (const item of sections(entries[path])) {
      const target = resolve(path, item.name)
      const entry = target && usable(target)
      if (entry) collector.markDirect(nameOf(target!), entry.version!, item.dev)
    }
  }
  return collector.finish()
}

interface NpmEntry {
  name?: string
  version?: string
  resolved?: string
  link?: boolean
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type YamlValue = string | string[] | YamlMap
interface YamlMap { [key: string]: YamlValue }

function unquote(text: string): string {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replace(/\\(.)/g, '$1')
  return text
}

/**
 * Reads the YAML that pnpm and Yarn write: nested block maps, plain or quoted scalars and lists of
 * scalars. Flow collections such as `{integrity: ...}` stay as raw text.
 */
export function parseLockYaml(text: string): YamlMap {
  const root: YamlMap = {}
  const stack: { indent: number; map: YamlMap; parent?: YamlMap; key?: string }[] = [{ indent: -1, map: root }]
  for (const line of text.split(/\r?\n/)) {
    const content = line.trim()
    if (!content || content.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const top = stack[stack.length - 1]
    if (content.startsWith('- ')) {
      if (!top.parent || !top.key) continue
      const list = Array.isArray(top.parent[top.key]) ? top.parent[top.key] as string[] : []
      list.push(unquote(content.slice(2).trim()))
      top.parent[top.key] = list
      continue
    }
    let key: string
    let rest: string
    if (content[0] === '"' || content[0] === "'") {
      const quote = content[0]
      let end = 1
      while (end < content.length) {
        if (quote === '"' && content[end] === '\\') end += 2
        else if (quote === "'" && content[end] === "'" && content[end + 1] === "'") end += 2
        else if (content[end] === quote) break
        else end++
      }
      key = unquote(content.slice(0, end + 1))
      rest = content.slice(end + 1).replace(/^:/, '').trim()
    } else {
      const colon = content.endsWith(':') && !content.includes(': ') ? content.length - 1 : content.indexOf(': ')
      if (colon < 0) continue
      key = content.slice(0, colon)
      rest = content.slice(colon + 1).trim()
    }
    if (rest) {
      top.map[key] = unquote(rest)
    } else {
      const child: YamlMap = {}
      top.map[key] = child
      stack.push({ indent, map: child, parent: top.map, key })
    }
  }
  return root
}

const asMap = (value: YamlValue | undefined): YamlMap => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const asText = (value: YamlValue | undefined): string => (typeof value === 'string' ? value : '')

/** Splits `name@version`, where a scoped name starts with its own `@`. */
function splitKey(key: string): { name: string; version: string } | null {
  const at = key.indexOf('@', 1)
  return at > 0 ? { name: key.slice(0, at), version: key.slice(at + 1) } : null
}

function parsePnpmLock(text: string): LockedPackage[] {
  const lock = parseLockYaml(text)
  const major = Number.parseInt(asText(lock.lockfileVersion), 10)
  if (!(major >= 6)) throw new Error(t('Старый формат pnpm-lock.yaml. Обнови его командой pnpm install.'))
  // A version is `1.2.3(peer@4)`, or `real-name@1.2.3` for an alias; version 6 also puts a slash in front.
  const target = (name: string, value: string): string | null => {
    const bare = value.replace(/^\//, '').split('(')[0]
    if (RELEASE.test(bare)) return packageKey(name, bare)
    const alias = splitKey(bare)
    return alias && RELEASE.test(alias.version) ? packageKey(alias.name, alias.version) : null
  }
  const packages = asMap(lock.packages)
  const nodes = major >= 9 ? asMap(lock.snapshots) : packages
  const collector = new Collector()
  for (const [rawKey, value] of Object.entries(nodes)) {
    const id = splitKey(rawKey.replace(/^\//, '').split('(')[0])
    if (!id || !RELEASE.test(id.version)) continue
    const resolution = asText(asMap(major >= 9 ? packages[packageKey(id.name, id.version)] : value).resolution)
    if (resolution.includes('type:') || (/tarball:/.test(resolution) && !/tarball: https:\/\/registry\.(npmjs\.org|yarnpkg\.com)\//.test(resolution))) continue
    const entry = asMap(value)
    const dependencies = Object.entries({ ...asMap(entry.dependencies), ...asMap(entry.optionalDependencies) })
      .map(([name, version]) => target(name, asText(version))).filter((key) => key !== null)
    collector.add(id.name, id.version, dependencies)
  }
  const importers = lock.importers ? Object.values(asMap(lock.importers)).map(asMap) : [lock]
  for (const importer of importers) {
    for (const section of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, value] of Object.entries(asMap(importer[section]))) {
        const key = target(name, typeof value === 'string' ? value : asText(asMap(value).version))
        const id = key && splitKey(key)
        if (id) collector.markDirect(id.name, id.version, section === 'devDependencies')
      }
    }
  }
  return collector.finish()
}

/** Both Yarn formats: the classic text one and the YAML one from Yarn 2 and later. */
function parseYarnLock(text: string, manifest: string | null): LockedPackage[] {
  const entries = /^__metadata:/m.test(text) ? berryEntries(text) : classicEntries(text)
  const bySpec = new Map<string, YarnEntry>()
  for (const entry of entries) for (const spec of entry.specs) bySpec.set(spec, entry)
  const find = (name: string, range: string): YarnEntry | undefined => bySpec.get(`${name}@${range}`) ?? bySpec.get(`${name}@npm:${range}`)
  const collector = new Collector()
  for (const entry of entries) {
    if (!entry.registry) continue
    const dependencies = Object.entries(entry.dependencies).map(([name, range]) => find(name, range))
      .filter((item) => item?.registry).map((item) => packageKey(item!.name, item!.version))
    collector.add(entry.name, entry.version, dependencies)
  }
  const workspaces = entries.filter((entry) => !entry.registry && entry.workspace)
  const devNames = new Set(manifestSections(manifest).filter((item) => item.dev).map((item) => item.name))
  const runtimeNames = new Set(manifestSections(manifest).filter((item) => !item.dev).map((item) => item.name))
  const direct = workspaces.length
    ? workspaces.flatMap((entry) => Object.entries(entry.dependencies).map(([name, range]) => ({ name, range, dev: devNames.has(name) && !runtimeNames.has(name) })))
    : manifestSections(manifest)
  for (const item of direct) {
    const entry = find(item.name, item.range)
    if (entry?.registry) collector.markDirect(entry.name, entry.version, item.dev)
  }
  return collector.finish()
}

interface YarnEntry {
  specs: string[]
  name: string
  version: string
  registry: boolean
  workspace: boolean
  dependencies: Record<string, string>
}

function classicEntries(text: string): YarnEntry[] {
  const entries: YarnEntry[] = []
  let current: YarnEntry | null = null
  let inDependencies = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!line.startsWith(' ')) {
      const specs = line.replace(/:$/, '').split(/,\s*/).map((spec) => unquote(spec.trim()))
      current = { specs, name: splitKey(specs[0])?.name ?? specs[0], version: '', registry: false, workspace: false, dependencies: {} }
      entries.push(current)
      inDependencies = false
      continue
    }
    if (!current) continue
    const content = line.trim()
    if (line.startsWith('    ') && inDependencies) {
      const match = /^("[^"]+"|\S+)\s+(.+)$/.exec(content)
      if (match) current.dependencies[unquote(match[1])] = unquote(match[2])
      continue
    }
    inDependencies = content === 'dependencies:' || content === 'optionalDependencies:'
    const field = /^(\w+)\s+(.+)$/.exec(content)
    if (field?.[1] === 'version') current.version = unquote(field[2])
    if (field?.[1] === 'resolved') current.registry = PUBLIC_NPM.test(unquote(field[2]))
  }
  return entries.filter((entry) => !entry.registry || RELEASE.test(entry.version))
}

function berryEntries(text: string): YarnEntry[] {
  return Object.entries(parseLockYaml(text)).filter(([key]) => key !== '__metadata').map(([key, value]) => {
    const entry = asMap(value)
    const resolution = asText(entry.resolution)
    const id = splitKey(resolution)
    const version = asText(entry.version)
    return {
      specs: key.split(/,\s*/),
      name: id?.name ?? key,
      version,
      registry: Boolean(id?.version.startsWith('npm:')) && RELEASE.test(version),
      workspace: Boolean(id?.version.startsWith('workspace:')),
      dependencies: Object.fromEntries(Object.entries({ ...asMap(entry.dependencies), ...asMap(entry.optionalDependencies) }).map(([name, range]) => [name, asText(range)]))
    }
  })
}

const NPM_FORMATS: LockfileFormat[] = [
  { file: 'package-lock.json', ecosystem: 'npm', manager: 'npm', parse: parsePackageLock },
  { file: 'npm-shrinkwrap.json', ecosystem: 'npm', manager: 'npm', parse: parsePackageLock },
  { file: 'pnpm-lock.yaml', ecosystem: 'npm', manager: 'pnpm', parse: parsePnpmLock },
  { file: 'yarn.lock', ecosystem: 'npm', manager: 'yarn', manifest: 'package.json', parse: parseYarnLock }
]

export const FORMATS: LockfileFormat[] = [...NPM_FORMATS, ...MORE_FORMATS]

/** Folders whose lockfiles belong to someone else's code that happens to be checked in. */
const FOREIGN = /(^|\/)(node_modules|vendor|third_party)\//

async function readText(cwd: string, rev: string, path: string): Promise<string | null> {
  const { stdout, code } = await runGit(cwd, ['cat-file', 'blob', `${rev}:${path}`], { okCodes: [128] })
  return code === 0 ? stdout.toString('utf8') : null
}

export function parseLockfile(path: string, text: string, manifest: string | null): Lockfile {
  const format = FORMATS.find((item) => item.file === posix.basename(path))
  if (!format) throw new Error(t('Неизвестный формат: {path}', { path }))
  return { path, ecosystem: format.ecosystem, manager: format.manager, packages: format.parse(text, manifest) }
}

/** Finds and reads every lockfile in a commit. */
export async function readLockfiles(cwd: string, rev = 'HEAD'): Promise<{ lockfiles: Lockfile[]; skipped: { path: string; reason: string }[] }> {
  const files = new Set(await listFiles(cwd, rev))
  const lockfiles: Lockfile[] = []
  const skipped: { path: string; reason: string }[] = []
  for (const path of [...files].sort()) {
    const format = FORMATS.find((item) => item.file === posix.basename(path))
    if (!format || FOREIGN.test(path)) continue
    const manifestPath = format.manifest ? posix.join(posix.dirname(path), format.manifest) : null
    try {
      const text = await readText(cwd, rev, path)
      if (text === null) continue
      const manifest = manifestPath && files.has(manifestPath) ? await readText(cwd, rev, manifestPath) : null
      lockfiles.push(parseLockfile(path, text, manifest))
    } catch (error) {
      skipped.push({ path, reason: (error as Error).message })
    }
  }
  return { lockfiles, skipped }
}
