import { packageKey, settleDev, type LockedPackage, type LockfileFormat } from '../shared/deps'
import { t } from '../shared/i18n'

const PYPI = /^https:\/\/pypi\.org\/simple\/?$/
const RUBYGEMS = /^https?:\/\/rubygems\.org\/?$/
const CRATES_IO = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'])
const RELEASE = /^v?\d/

function lineError(file: string, line: number): Error {
  return new Error(t('Строка {line} в {file} не читается.', { line, file }))
}

function layoutError(file: string): Error {
  return new Error(t('Файл {file} устроен не так, как ожидалось.', { file }))
}

/** Package names as PEP 503 compares them, which is also how OSV and deps.dev expect them. */
function pythonName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** The name at the start of a PEP 508 requirement such as `Jinja2[i18n] (>=2.11) ; python_version > "3"`. */
function requirementName(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(requirement)
  return match ? pythonName(match[1]) : null
}

/** Adds a package, merging it with one already read under the same key, as platform variants are. */
function addPackage(packages: Map<string, LockedPackage>, item: LockedPackage): void {
  const known = packages.get(packageKey(item.name, item.version))
  if (!known) {
    packages.set(packageKey(item.name, item.version), { ...item, dependencies: [...new Set(item.dependencies)] })
    return
  }
  known.dependencies = [...new Set([...known.dependencies, ...item.dependencies])]
  known.direct ||= item.direct
  known.dev &&= item.dev
}

/** Marks a package the project lists itself; one that any runtime section lists stays runtime. */
function markDirect(packages: Map<string, LockedPackage>, key: string, dev: boolean): void {
  const item = packages.get(key)
  if (!item) return
  item.dev = item.direct ? item.dev && dev : dev
  item.direct = true
}

/**
 * Drops edges to packages that were left out. Formats without edges keep the `dev` they were read with,
 * because `settleDev` would call every package that is not direct a dev one.
 */
function finish(packages: Map<string, LockedPackage>, settle: boolean): LockedPackage[] {
  const list = [...packages.values()].map((item) => ({
    ...item,
    dependencies: item.dependencies.filter((key) => key !== packageKey(item.name, item.version) && packages.has(key))
  }))
  return settle ? settleDev(list) : list
}

/** Characters outside quoted strings, with the bracket depth before each, and the depth at the end. */
function plainChars(text: string): { chars: { index: number; char: string; depth: number }[]; depth: number } {
  const chars: { index: number; char: string; depth: number }[] = []
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"' || char === "'") {
      let end = index + 1
      while (end < text.length && text[end] !== char) end += char === '"' && text[end] === '\\' ? 2 : 1
      index = end
      continue
    }
    chars.push({ index, char, depth })
    if (char === '[' || char === '{') depth++
    if (char === ']' || char === '}') depth--
  }
  return { chars, depth }
}

function withoutComment(line: string): string {
  const hash = plainChars(line).chars.find((item) => item.char === '#')
  return hash ? line.slice(0, hash.index) : line
}

/** Splits at the commas that are not inside a string or a nested array or table. */
function splitTop(text: string): string[] {
  const parts: string[] = []
  let start = 0
  for (const item of plainChars(text).chars) {
    if (item.char !== ',' || item.depth !== 0) continue
    parts.push(text.slice(start, item.index))
    start = item.index + 1
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

function splitKeyValue(text: string): [string, string] | null {
  const equals = plainChars(text).chars.find((item) => item.char === '=')
  if (!equals) return null
  const key = text.slice(0, equals.index).trim()
  return key ? [tomlString(key), text.slice(equals.index + 1).trim()] : null
}

/** A TOML string or bare key; anything else comes back as written. */
function tomlString(raw: string | undefined): string {
  if (!raw) return ''
  if (raw.startsWith("'")) return raw.slice(1, -1)
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

/** The raw items of a TOML array. */
function tomlArray(raw: string | undefined): string[] {
  return raw?.startsWith('[') ? splitTop(raw.slice(1, raw.lastIndexOf(']'))) : []
}

/** The raw values of an inline TOML table. */
function tomlTable(raw: string | undefined): Map<string, string> {
  if (!raw?.startsWith('{')) return new Map()
  return new Map(splitTop(raw.slice(1, raw.lastIndexOf('}'))).map(splitKeyValue).filter((pair) => pair !== null))
}

interface TomlTable {
  path: string[]
  /** Opened by `[[...]]`, so it is one item of an array of tables. */
  array: boolean
  values: Map<string, string>
}

/**
 * Reads the TOML that lockfiles and project files use: tables, arrays of tables and `key = value`
 * lines whose arrays may run over several lines. Values stay raw text for the helpers above.
 */
function readToml(text: string, file: string): TomlTable[] {
  const tables: TomlTable[] = [{ path: [], array: false, values: new Map() }]
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const start = index + 1
    const line = withoutComment(lines[index]).trim()
    if (!line) continue
    const header = /^\[\[(.+)\]\]$/.exec(line) ?? /^\[(.+)\]$/.exec(line)
    if (header) {
      const dots = plainChars(header[1]).chars.filter((item) => item.char === '.').map((item) => item.index)
      const path = [-1, ...dots].map((dot, part) => tomlString(header[1].slice(dot + 1, dots[part]).trim()))
      tables.push({ path, array: line.startsWith('[['), values: new Map() })
      continue
    }
    const pair = splitKeyValue(line)
    if (!pair || !pair[1]) throw lineError(file, start)
    let value = pair[1]
    const triple = value.slice(0, 3)
    if ((triple === '"""' || triple === "'''") && !value.slice(3).includes(triple)) {
      // Only descriptions use multi-line strings, and nothing here reads them.
      index++
      while (index < lines.length && !lines[index].includes(triple)) index++
      value = '""'
    } else {
      // Strings never span lines here, so the depth of each line adds up.
      let depth = plainChars(value).depth
      while (depth > 0 && ++index < lines.length) {
        const next = withoutComment(lines[index])
        value += `\n${next}`
        depth += plainChars(next).depth
      }
    }
    if (index >= lines.length) throw lineError(file, start)
    tables[tables.length - 1].values.set(pair[0], value)
  }
  return tables
}

interface TomlPackage {
  values: Map<string, string>
  /** Tables such as `[package.dependencies]` that follow a `[[package]]`, by the rest of their name. */
  tables: Map<string, Map<string, string>>
}

function tomlPackages(tables: TomlTable[], file: string): TomlPackage[] {
  const packages: TomlPackage[] = []
  for (const table of tables) {
    if (table.path[0] !== 'package') continue
    if (table.array && table.path.length === 1) packages.push({ values: table.values, tables: new Map() })
    else if (packages.length) packages[packages.length - 1].tables.set(table.path.slice(1).join('.'), table.values)
  }
  if (packages.some((item) => !item.values.has('name'))) throw layoutError(file)
  return packages
}

function parseCargoLock(text: string): LockedPackage[] {
  const crates = tomlPackages(readToml(text, 'Cargo.lock'), 'Cargo.lock').map((entry) => ({
    name: tomlString(entry.values.get('name')),
    version: tomlString(entry.values.get('version')),
    source: tomlString(entry.values.get('source')),
    dependencies: tomlArray(entry.values.get('dependencies')).map(tomlString)
  }))
  // A dependency is `name`, `name version` or `name version (source)`: Cargo writes just enough to tell packages apart.
  const resolve = (spec: string): string | null => {
    const [, name, version, source] = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/.exec(spec) ?? []
    const crate = crates.find((item) => item.name === name && (!version || item.version === version) && (!source || item.source === source))
    return crate && CRATES_IO.has(crate.source) ? packageKey(crate.name, crate.version) : null
  }
  const packages = new Map<string, LockedPackage>()
  for (const crate of crates.filter((item) => CRATES_IO.has(item.source))) {
    const dependencies = crate.dependencies.map(resolve).filter((key) => key !== null)
    addPackage(packages, { name: crate.name, version: crate.version, direct: false, dev: false, dependencies })
  }
  // Packages without a source are the workspace and its path dependencies. Cargo.lock does not say which needs are dev ones.
  for (const crate of crates.filter((item) => !item.source)) {
    for (const key of crate.dependencies.map(resolve)) if (key) markDirect(packages, key, false)
  }
  return finish(packages, true)
}

const GO_DIRECTIVES = new Set(['module', 'go', 'toolchain', 'godebug', 'require', 'replace', 'exclude', 'retract', 'tool', 'ignore'])

/** Reads `require` lines from go.mod. Go has no dev dependencies, and go.mod has no edges. */
function parseGoMod(text: string): LockedPackage[] {
  const requires: { path: string; version: string; direct: boolean }[] = []
  // By `path@version` or `path`; null when the module is replaced with a local folder.
  const replaces = new Map<string, { path: string; version: string } | null>()
  const words = (line: string): string[] => line.split(/\s+/).map((word) => (word.startsWith('"') ? tomlString(word) : word))
  let block: string | null = null
  let hasModule = false
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line) continue
    let verb: string | null = block
    let rest = line
    if (block && line === ')') {
      block = null
      continue
    }
    if (!block) {
      const match = /^(\w+)\s*(.*)$/.exec(line)
      if (!match || !GO_DIRECTIVES.has(match[1])) throw lineError('go.mod', index + 1)
      verb = match[1]
      rest = match[2]
      if (rest === '(') {
        block = verb
        continue
      }
    }
    if (verb === 'module') hasModule = true
    if (verb === 'require') {
      const [path, version] = words(rest)
      if (!path || !version) throw lineError('go.mod', index + 1)
      requires.push({ path, version, direct: !/\/\/\s*indirect\b/.test(raw) })
    }
    if (verb === 'replace') {
      const [from, to] = rest.split('=>').map((side) => words(side.trim()))
      if (!from?.[0] || !to?.[0]) throw lineError('go.mod', index + 1)
      replaces.set(from[1] ? `${from[0]}@${from[1]}` : from[0], to[1] ? { path: to[0], version: to[1] } : null)
    }
  }
  if (!hasModule || block) throw layoutError('go.mod')
  const packages = new Map<string, LockedPackage>()
  for (const item of requires) {
    const key = `${item.path}@${item.version}`
    const target = replaces.has(key) ? replaces.get(key) : replaces.has(item.path) ? replaces.get(item.path) : item
    if (target) addPackage(packages, { name: target.path, version: target.version, direct: item.direct, dev: false, dependencies: [] })
  }
  return finish(packages, false)
}

/** The packages a pyproject.toml lists itself, from Poetry's sections and the standard ones. */
function pyprojectDependencies(text: string): { name: string; dev: boolean }[] {
  const found: { name: string; dev: boolean }[] = []
  const addRequirements = (raw: string | undefined, dev: boolean): void => {
    for (const item of tomlArray(raw)) {
      const name = item.startsWith('{') ? null : requirementName(tomlString(item))
      if (name) found.push({ name, dev })
    }
  }
  for (const table of readToml(text, 'pyproject.toml')) {
    const [tool, poetry, section, group, groupSection] = table.path
    if (tool === 'tool' && poetry === 'poetry') {
      // `[tool.poetry.dependencies.name]` describes one dependency in a table of its own.
      const depth = section === 'group' ? 5 : 3
      const dev = section === 'dev-dependencies' || (section === 'group' && group !== 'main')
      if (section !== 'dependencies' && section !== 'dev-dependencies' && !(section === 'group' && groupSection === 'dependencies')) continue
      if (table.path.length === depth) {
        for (const name of table.values.keys()) if (name !== 'python') found.push({ name: pythonName(name), dev })
      } else if (table.path.length === depth + 1) {
        found.push({ name: pythonName(table.path[depth]), dev })
      }
    } else if (table.path.length === 1 && table.path[0] === 'project') {
      addRequirements(table.values.get('dependencies'), false)
    } else if (table.path.join('.') === 'project.optional-dependencies' || (table.path.length === 1 && table.path[0] === 'dependency-groups')) {
      for (const raw of table.values.values()) addRequirements(raw, true)
    }
  }
  return found
}

function parsePoetryLock(text: string, manifest: string | null): LockedPackage[] {
  // A source table means git, a local path, a URL or a private index.
  const entries = tomlPackages(readToml(text, 'poetry.lock'), 'poetry.lock')
    .filter((entry) => !entry.tables.has('source') || PYPI.test(tomlString(entry.tables.get('source')?.get('url'))))
  // Poetry may lock two versions of one package for different Python versions.
  const byName = new Map<string, string[]>()
  for (const entry of entries) {
    const name = pythonName(tomlString(entry.values.get('name')))
    byName.set(name, [...byName.get(name) ?? [], packageKey(name, tomlString(entry.values.get('version')))])
  }
  const packages = new Map<string, LockedPackage>()
  for (const entry of entries) {
    const dependencies = [...entry.tables.get('dependencies')?.keys() ?? []].flatMap((name) => byName.get(pythonName(name)) ?? [])
    const groups = tomlArray(entry.values.get('groups')).map(tomlString)
    // Without pyproject.toml, the groups (or the category of older Poetry) are all there is to tell dev packages by.
    const dev = entry.values.has('groups') ? !groups.includes('main') : tomlString(entry.values.get('category')) === 'dev'
    addPackage(packages, { name: pythonName(tomlString(entry.values.get('name'))), version: tomlString(entry.values.get('version')), direct: false, dev: manifest ? false : dev, dependencies })
  }
  if (!manifest) return finish(packages, false)
  for (const item of pyprojectDependencies(manifest)) for (const key of byName.get(item.name) ?? []) markDirect(packages, key, item.dev)
  return finish(packages, true)
}

function parseUvLock(text: string): LockedPackage[] {
  const entries = tomlPackages(readToml(text, 'uv.lock'), 'uv.lock').map((entry) => ({
    ...entry,
    name: pythonName(tomlString(entry.values.get('name'))),
    version: tomlString(entry.values.get('version')),
    source: tomlTable(entry.values.get('source'))
  }))
  const fromPypi = entries.filter((entry) => PYPI.test(tomlString(entry.source.get('registry'))))
  // An entry names a version only when the lockfile has more than one of that package.
  const resolve = (raw: string): string[] => {
    const spec = tomlTable(raw)
    const name = pythonName(tomlString(spec.get('name')))
    const version = tomlString(spec.get('version'))
    return fromPypi.filter((entry) => entry.name === name && (!version || entry.version === version)).map((entry) => packageKey(entry.name, entry.version))
  }
  const groups = (entry: TomlPackage, table: string): string[] => [...entry.tables.get(table)?.values() ?? []].flatMap(tomlArray)
  const packages = new Map<string, LockedPackage>()
  for (const entry of fromPypi) {
    const dependencies = [...tomlArray(entry.values.get('dependencies')), ...groups(entry, 'optional-dependencies')].flatMap(resolve)
    addPackage(packages, { name: entry.name, version: entry.version, direct: false, dev: false, dependencies })
  }
  // The project and its workspace members are editable or virtual; a local folder it depends on is part of it too.
  for (const root of entries.filter((entry) => ['editable', 'virtual', 'directory'].some((kind) => entry.source.has(kind)))) {
    for (const key of tomlArray(root.values.get('dependencies')).flatMap(resolve)) markDirect(packages, key, false)
    for (const key of [...groups(root, 'dev-dependencies'), ...groups(root, 'optional-dependencies')].flatMap(resolve)) markDirect(packages, key, true)
  }
  return finish(packages, true)
}

interface PipfileEntry {
  version?: string
  index?: string
}

/** Reads `default` and `develop`. Pipfile.lock has no edges, so the section is what says a package is dev. */
function parsePipfileLock(text: string, manifest: string | null): LockedPackage[] {
  const lock = JSON.parse(text) as { _meta?: { sources?: { name: string; url: string }[] }; default?: Record<string, PipfileEntry>; develop?: Record<string, PipfileEntry> }
  if (!lock || typeof lock.default !== 'object' || typeof lock.develop !== 'object') throw layoutError('Pipfile.lock')
  const sources = lock._meta?.sources ?? []
  const publicIndexes = new Set(sources.filter((source) => PYPI.test(source.url)).map((source) => source.name))
  const listed = manifest
    ? new Set(readToml(manifest, 'Pipfile').filter((table) => ['packages', 'dev-packages'].includes(table.path.join('.'))).flatMap((table) => [...table.values.keys()].map(pythonName)))
    : null
  const packages = new Map<string, LockedPackage>()
  for (const [section, dev] of [[lock.default, false], [lock.develop, true]] as const) {
    for (const [rawName, entry] of Object.entries(section)) {
      // Git, local and URL entries have no version. An entry without an index comes from the first source.
      const index = entry.index ?? sources[0]?.name
      if (!entry.version?.startsWith('==') || entry.version.startsWith('===') || (sources.length && !publicIndexes.has(index ?? ''))) continue
      const name = pythonName(rawName)
      addPackage(packages, { name, version: entry.version.slice(2), direct: listed ? listed.has(name) : true, dev, dependencies: [] })
    }
  }
  return finish(packages, false)
}

/** Takes exact `name==version` pins only, since nothing else says which version is installed. */
function parseRequirements(text: string): LockedPackage[] {
  const packages = new Map<string, LockedPackage>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const start = index + 1
    let raw = lines[index]
    while (raw.endsWith('\\') && index + 1 < lines.length) raw = `${raw.slice(0, -1)} ${lines[++index]}`
    const line = raw.replace(/(^|\s)#.*$/, '').trim()
    if (!line || line.startsWith('-')) continue
    if (!/^[A-Za-z0-9./\\~]/.test(line)) throw lineError('requirements.txt', start)
    // Markers follow `;` and options such as `--hash` follow the requirement.
    const requirement = line.split(';')[0].split(/\s--?\w/)[0].trim()
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[[^\]]*\])?\s*==(?!=)\s*([0-9][A-Za-z0-9._+!-]*)$/.exec(requirement)
    if (match) addPackage(packages, { name: pythonName(match[1]), version: match[2], direct: true, dev: false, dependencies: [] })
  }
  return finish(packages, true)
}

/** Reads gems from rubygems.org. Gemfile.lock does not say which groups a gem is in, so none is dev. */
function parseGemfileLock(text: string): LockedPackage[] {
  const specs: { name: string; version: string; dependencies: string[] }[] = []
  const direct: string[] = []
  let section = ''
  let remotes: string[] = []
  let current: { name: string; version: string; dependencies: string[] } | null = null
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    if (!line.startsWith(' ')) {
      if (!/^[A-Z][A-Z ]*$/.test(line.trimEnd())) throw lineError('Gemfile.lock', index + 1)
      section = line.trimEnd()
      remotes = []
      continue
    }
    if (section === 'DEPENDENCIES') {
      const name = /^ {2}([^\s!]+)/.exec(line)?.[1]
      if (name) direct.push(name)
      continue
    }
    if (section !== 'GEM') continue
    const remote = /^ {2}remote: (\S+)/.exec(line)?.[1]
    if (remote) remotes.push(remote)
    // Older Bundler puts every remote in one section, and then gems cannot be told apart by source.
    const publicSource = remotes.length > 0 && remotes.every((item) => RUBYGEMS.test(item))
    // Bundler reads everything after the first dash as the platform, as in `1.13.0-x86_64-linux`.
    const spec = /^ {4}(\S+) \(([^-)]+)(?:-[^)]*)?\)$/.exec(line)
    if (spec) {
      current = publicSource ? { name: spec[1], version: spec[2], dependencies: [] } : null
      if (current) specs.push(current)
    }
    const dependency = /^ {6}(\S+)/.exec(line)?.[1]
    if (dependency) current?.dependencies.push(dependency)
  }
  const keysByName = new Map<string, string[]>()
  for (const spec of specs) keysByName.set(spec.name, [...new Set([...keysByName.get(spec.name) ?? [], packageKey(spec.name, spec.version)])])
  const packages = new Map<string, LockedPackage>()
  for (const spec of specs) {
    addPackage(packages, { name: spec.name, version: spec.version, direct: false, dev: false, dependencies: spec.dependencies.flatMap((name) => keysByName.get(name) ?? []) })
  }
  for (const name of direct) for (const key of keysByName.get(name) ?? []) markDirect(packages, key, false)
  return finish(packages, true)
}

interface ComposerPackage {
  name: string
  version: string
  dist?: { type?: string }
  require?: Record<string, string>
}

/** Reads `packages` and `packages-dev`, which already say which packages are dev. */
function parseComposerLock(text: string, manifest: string | null): LockedPackage[] {
  const lock = JSON.parse(text) as { packages?: ComposerPackage[]; 'packages-dev'?: ComposerPackage[] }
  if (!lock || !Array.isArray(lock.packages)) throw layoutError('composer.lock')
  const project = manifest ? JSON.parse(manifest) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> } : null
  // Composer compares names without case. `php` and `ext-*` are not packages and never appear in the lockfile.
  const listed = new Set(Object.keys({ ...project?.require, ...project?.['require-dev'] }).map((name) => name.toLowerCase()))
  const entries = [...lock.packages.map((item) => ({ item, dev: false })), ...(lock['packages-dev'] ?? []).map((item) => ({ item, dev: true }))]
    .filter(({ item }) => item.dist?.type !== 'path' && RELEASE.test(item.version))
  const keyByName = new Map(entries.map(({ item }) => [item.name.toLowerCase(), packageKey(item.name.toLowerCase(), item.version)]))
  const packages = new Map<string, LockedPackage>()
  for (const { item, dev } of entries) {
    const dependencies = Object.keys(item.require ?? {}).flatMap((name) => keyByName.get(name.toLowerCase()) ?? [])
    addPackage(packages, { name: item.name.toLowerCase(), version: item.version, direct: listed.has(item.name.toLowerCase()), dev, dependencies })
  }
  return finish(packages, false)
}

/** Lockfiles of ecosystems other than npm. */
export const MORE_FORMATS: LockfileFormat[] = [
  { file: 'Cargo.lock', ecosystem: 'crates.io', manager: 'cargo', parse: parseCargoLock },
  { file: 'go.mod', ecosystem: 'Go', manager: 'go', parse: parseGoMod },
  { file: 'poetry.lock', ecosystem: 'PyPI', manager: 'poetry', manifest: 'pyproject.toml', parse: parsePoetryLock },
  { file: 'uv.lock', ecosystem: 'PyPI', manager: 'uv', parse: parseUvLock },
  { file: 'Pipfile.lock', ecosystem: 'PyPI', manager: 'pipenv', manifest: 'Pipfile', parse: parsePipfileLock },
  { file: 'requirements.txt', ecosystem: 'PyPI', manager: 'pip', parse: parseRequirements },
  { file: 'Gemfile.lock', ecosystem: 'RubyGems', manager: 'bundler', parse: parseGemfileLock },
  { file: 'composer.lock', ecosystem: 'Packagist', manager: 'composer', manifest: 'composer.json', parse: parseComposerLock }
]
