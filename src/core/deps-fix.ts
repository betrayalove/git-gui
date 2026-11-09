import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix } from 'node:path'
import { packageKey, type DependencyFix, type Ecosystem, type FixResult, type LockedPackage, type PackageManager } from '../shared/deps'
import { t } from '../shared/i18n'
import { compareVersions } from '../shared/versions'
import { childEnv, git, gitLine, revParse, runGit } from './git'
import { parseLockfile } from './lockfiles'
import { moveRefs } from './rewrite'

type NodeManager = 'npm' | 'pnpm' | 'yarn'
type Command = [NodeManager, ...string[]]

const LOCKFILES: Record<NodeManager, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock']
}

const NPM_NAME = /^(@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/
const NPM_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/
const PYPI_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const PYPI_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/
/** A specifier that names one version, with an operator that can stay when the version changes. */
const PLAIN_SPEC = /^(\^|~|>=|=)?(v?)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)$/
const MANIFEST_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies']
/** A package manager that hangs, for example on a registry that never answers, is stopped after this. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000

const NPM_FLAGS = ['--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
const PNPM_FLAGS = ['--lockfile-only', '--ignore-scripts']

/** Environment that keeps install scripts off whatever a project's own settings say. */
const SCRIPTS_OFF: Record<string, string> = {
  npm_config_ignore_scripts: 'true',
  YARN_ENABLE_SCRIPTS: '0',
  // CI services set these, and they would refuse to change the lockfile at all.
  YARN_ENABLE_IMMUTABLE_INSTALLS: '0',
  npm_config_frozen_lockfile: 'false',
  // Corepack asks before downloading a package manager, and nobody can answer here.
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  npm_config_update_notifier: 'false'
}

function validateFix(fix: DependencyFix): void {
  const path = fix.lockfile
  if (!path || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(t('Недопустимый путь к lockfile: {path}', { path }))
  }
  const file = posix.basename(path)
  if (fix.manager === 'pip') {
    if (!file.endsWith('.txt')) throw new Error(t('Для pip нужен файл requirements.txt, а не {path}', { path }))
  } else if (isNodeManager(fix.manager)) {
    if (!LOCKFILES[fix.manager].includes(file)) throw new Error(t('{path} не lockfile {manager}', { path, manager: fix.manager }))
  } else {
    throw new Error(t('Chronicle пока не умеет обновлять зависимости {manager}. Обнови их вручную.', { manager: fix.manager }))
  }
  if (!fix.updates.length) throw new Error(t('Не выбрано ни одного обновления'))
  const [name, version] = fix.manager === 'pip' ? [PYPI_NAME, PYPI_VERSION] : [NPM_NAME, NPM_VERSION]
  for (const update of fix.updates) {
    if (!name.test(update.name)) throw new Error(t('Недопустимое имя пакета: {name}', { name: update.name }))
    if (!version.test(update.from) || !version.test(update.to)) {
      throw new Error(t('Недопустимая версия {name}: {from} → {to}', { name: update.name, from: update.from, to: update.to }))
    }
  }
}

function isNodeManager(manager: PackageManager): manager is NodeManager {
  return manager === 'npm' || manager === 'pnpm' || manager === 'yarn'
}

function installCommand(manager: NodeManager): Command {
  if (manager === 'npm') return ['npm', 'install', ...NPM_FLAGS]
  if (manager === 'pnpm') return ['pnpm', 'install', ...PNPM_FLAGS, '--no-frozen-lockfile']
  return ['yarn', 'install', '--mode=update-lockfile']
}

/** Re-resolves packages within the ranges that ask for them, without touching the manifest. */
function updateCommand(manager: NodeManager, names: string[]): Command {
  if (manager === 'npm') return ['npm', 'update', ...NPM_FLAGS, '--', ...names]
  if (manager === 'pnpm') return ['pnpm', 'update', '--depth', 'Infinity', ...PNPM_FLAGS, '--', ...names]
  return ['yarn', 'up', '--recursive', '--mode=update-lockfile', '--', ...names]
}

/**
 * The commands a fix may run, in order, so the person sees them before agreeing. The first install
 * runs when the manifest lists a package to raise. The update runs only for packages still at the
 * old version after that, and the last install only when an override had to be added, so a real
 * run may skip commands or names. A `requirements.txt` is edited as text, with no command.
 */
export function fixCommands(fix: DependencyFix): string[][] {
  validateFix(fix)
  if (!isNodeManager(fix.manager)) return []
  const manager = fix.manager
  const commands: string[][] = []
  if (fix.updates.some((update) => update.direct)) commands.push(installCommand(manager))
  commands.push(updateCommand(manager, [...new Set(fix.updates.map((update) => update.name))]))
  if (fix.updates.some((update) => !update.direct)) {
    if (manager === 'pnpm') commands.push(['pnpm', '--version'])
    commands.push(installCommand(manager))
  }
  return commands
}

// Running package managers

/** Where each package manager's JavaScript entry point sits inside a `node_modules` folder. */
const ENTRY_POINTS: Record<NodeManager, string[]> = {
  npm: ['npm/bin/npm-cli.js'],
  pnpm: ['pnpm/bin/pnpm.cjs', 'corepack/dist/pnpm.js'],
  yarn: ['yarn/bin/yarn.js', 'corepack/dist/yarn.js']
}

/**
 * How to start a package manager without a shell. On Windows npm, pnpm and Yarn are installed as
 * `.cmd` wrappers, which Node can start only through cmd.exe, and cmd.exe would read `&` or `^` in
 * an argument as its own syntax. So a `.cmd` wrapper is replaced by what it does: Node running the
 * package manager's JavaScript entry point. The installers from Node, npm, Corepack, nvm-windows
 * and Scoop put the wrapper next to a `node_modules` folder that holds it, and a `node_modules/.bin`
 * folder, as `npm install` and pnpm/action-setup make, sits inside one. A real `.exe`, as Volta and
 * standalone pnpm install, starts directly. Elsewhere the name is found on PATH as usual.
 */
export function resolveProgram(name: NodeManager, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { file: string; prefix: string[] } {
  if (platform !== 'win32') return { file: name, prefix: [] }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const folders = (pathKey ? env[pathKey] ?? '' : '').split(';').filter(Boolean)
  for (const folder of folders) {
    if (existsSync(join(folder, `${name}.exe`))) return { file: join(folder, `${name}.exe`), prefix: [] }
    if (!existsSync(join(folder, `${name}.cmd`))) continue
    const modules = basename(folder) === '.bin' ? [dirname(folder)] : [join(folder, 'node_modules')]
    const script = modules.flatMap((root) => ENTRY_POINTS[name].map((entry) => join(root, entry))).find((path) => existsSync(path))
    if (!script) continue
    const node = join(folder, 'node.exe')
    return { file: existsSync(node) ? node : 'node', prefix: [script] }
  }
  throw new Error(t('Не нашёл {name}. Установи его или проверь PATH.', { name }))
}

/** Runs npm, pnpm or Yarn without a shell and with install scripts off, and returns what it printed. */
export async function runPackageManager(cwd: string, command: Command): Promise<string> {
  const env = childEnv(SCRIPTS_OFF)
  const [name, ...args] = command
  const program = resolveProgram(name, env)
  return new Promise((resolve, reject) => {
    const child = spawn(program.file, [...program.prefix, ...args], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      reject(new Error(missing ? t('Не нашёл {name}. Установи его или проверь PATH.', { name }) : error.message))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = Buffer.concat(output).toString('utf8')
      if (code === 0) return resolve(text)
      const tail = text.trim().split(/\r?\n/).slice(-15).join('\n')
      reject(new Error(t('Команда {command} завершилась с ошибкой:\n{message}', { command: command.join(' '), message: tail || String(code) })))
    })
  })
}

// Editing JSON without reformatting it

interface JsonNode {
  start: number
  end: number
  members?: Map<string, JsonNode>
}

/** Where each value of a JSON text is, so one can be changed and the rest kept byte for byte. */
function jsonSpans(text: string): JsonNode {
  JSON.parse(text)
  let index = 0
  const skipSpace = (): void => {
    while (/\s/.test(text[index] ?? '')) index++
  }
  const readString = (): string => {
    const start = index++
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    index++
    return JSON.parse(text.slice(start, index)) as string
  }
  const readValue = (): JsonNode => {
    skipSpace()
    const start = index
    const open = text[index]
    if (open === '{' || open === '[') {
      const members = open === '{' ? new Map<string, JsonNode>() : undefined
      const close = open === '{' ? '}' : ']'
      index++
      skipSpace()
      while (text[index] !== close) {
        if (members) {
          skipSpace()
          const key = readString()
          skipSpace()
          index++
          members.set(key, readValue())
        } else {
          readValue()
        }
        skipSpace()
        if (text[index] === ',') index++
        skipSpace()
      }
      index++
      return { start, end: index, members }
    }
    if (open === '"') readString()
    else while (index < text.length && !/[\s,\]}]/.test(text[index])) index++
    return { start, end: index }
  }
  return readValue()
}

function replaceSpan(text: string, node: JsonNode, value: string): string {
  return text.slice(0, node.start) + value + text.slice(node.end)
}

/** Sets a string at a path of object keys, adding the objects that are missing, in the file's own indentation. */
function setJsonString(text: string, path: string[], value: string): string {
  // A manifest written on one line stays on one line.
  const compact = !text.trim().includes('\n')
  const unit = compact ? '' : /^([ \t]+)"/m.exec(text)?.[1] ?? '  '
  const eol = compact ? '' : text.includes('\r\n') ? '\r\n' : '\n'
  const render = (keys: string[], depth: number): string => keys.length
    ? `{${eol}${unit.repeat(depth + 1)}${JSON.stringify(keys[0])}: ${render(keys.slice(1), depth + 1)}${eol}${unit.repeat(depth)}}`
    : JSON.stringify(value)
  let node = jsonSpans(text)
  for (let depth = 0; depth < path.length; depth++) {
    if (!node.members) throw new Error(t('В package.json поле {name} не объект', { name: path.slice(0, depth).join('.') }))
    const child = node.members.get(path[depth])
    if (child && depth === path.length - 1) return replaceSpan(text, child, JSON.stringify(value))
    if (child) {
      node = child
      continue
    }
    const entry = `${JSON.stringify(path[depth])}: ${render(path.slice(depth + 1), depth + 1)}`
    const last = [...node.members.values()].pop()
    if (!last) return replaceSpan(text, node, `{${eol}${unit.repeat(depth + 1)}${entry}${eol}${unit.repeat(depth)}}`)
    return text.slice(0, last.end) + `,${eol}${unit.repeat(depth + 1)}${entry}` + text.slice(last.end)
  }
  return text
}

/**
 * Raises a direct dependency in the manifest and keeps its operator, so `^1.2.5` becomes `^1.2.6`.
 * Returns null when no section lists it with a specifier that names one version.
 */
function bumpSpecifier(manifest: string, name: string, to: string): string | null {
  let text = manifest
  let bumped = false
  for (const section of MANIFEST_SECTIONS) {
    const node = jsonSpans(text).members?.get(section)?.members?.get(name)
    if (!node) continue
    const spec = (JSON.parse(text.slice(node.start, node.end)) as unknown)
    const match = typeof spec === 'string' ? PLAIN_SPEC.exec(spec) : null
    if (!match) continue
    text = replaceSpan(text, node, JSON.stringify(`${match[1] ?? ''}${match[2]}${to}`))
    bumped = true
  }
  return bumped ? text : null
}

function listedInManifest(manifest: string, name: string): boolean {
  const sections = JSON.parse(manifest) as Record<string, unknown>
  return [...MANIFEST_SECTIONS, 'peerDependencies'].some((section) => {
    const value = sections[section]
    return Boolean(value && typeof value === 'object' && name in value)
  })
}

// Overrides

const quoteYaml = (text: string): string => `'${text.replaceAll("'", "''")}'`

function addYamlOverride(text: string, key: string, value: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const header = /^overrides:[ \t]*\r?\n/m.exec(text)
  if (header) {
    const at = header.index + header[0].length
    const indent = /^([ \t]+)\S/.exec(text.slice(at))?.[1] ?? '  '
    return `${text.slice(0, at)}${indent}${quoteYaml(key)}: ${quoteYaml(value)}${eol}${text.slice(at)}`
  }
  if (/^overrides:/m.test(text)) throw new Error(t('Не получилось добавить override в pnpm-workspace.yaml: запиши поле overrides списком по строкам.'))
  const separator = text && !text.endsWith('\n') ? eol : ''
  return `${text}${separator}overrides:${eol}  ${quoteYaml(key)}: ${quoteYaml(value)}${eol}`
}

/**
 * pnpm 10 reads overrides from both package.json and pnpm-workspace.yaml, and later versions only
 * from pnpm-workspace.yaml. A file that already has overrides keeps them in the same place.
 */
async function pnpmOverridesInWorkspace(project: string, manifest: string): Promise<boolean> {
  const workspace = await readFile(join(project, 'pnpm-workspace.yaml'), 'utf8').catch(() => null)
  if (workspace !== null && /^overrides:/m.test(workspace)) return true
  const pnpm = (JSON.parse(manifest) as { pnpm?: { overrides?: unknown } }).pnpm
  if (pnpm?.overrides) return false
  const version = await runPackageManager(project, ['pnpm', '--version'])
  return Number.parseInt(version.trim(), 10) >= 11
}

/**
 * Pins the old version to the fixed one wherever it is asked for. npm and pnpm apply a key such as
 * `leaf@1.0.0` to every range that admits 1.0.0, so the value is `^1.0.1` rather than an exact
 * version: a package that wants `^1.0.0` and already has 1.4.0 must not be moved down to 1.0.1.
 * Yarn matches the requested range as written, which its lockfile lists for each version.
 */
async function addOverrides(manager: NodeManager, project: string, updates: Update[], lockText: string): Promise<string[]> {
  const manifestPath = join(project, 'package.json')
  let manifest = await readFile(manifestPath, 'utf8')
  const files = ['package.json']
  if (manager === 'yarn') {
    const descriptors = yarnDescriptors(lockText)
    for (const update of updates) {
      for (const descriptor of descriptors.get(packageKey(update.name, update.from)) ?? []) {
        manifest = setJsonString(manifest, ['resolutions', descriptor], update.to)
      }
    }
  } else if (manager === 'pnpm' && await pnpmOverridesInWorkspace(project, manifest)) {
    const workspacePath = join(project, 'pnpm-workspace.yaml')
    let workspace = await readFile(workspacePath, 'utf8').catch(() => '')
    for (const update of updates) workspace = addYamlOverride(workspace, packageKey(update.name, update.from), `^${update.to}`)
    await writeFile(workspacePath, workspace)
    return ['pnpm-workspace.yaml']
  } else {
    const path = manager === 'pnpm' ? ['pnpm', 'overrides'] : ['overrides']
    for (const update of updates) manifest = setJsonString(manifest, [...path, packageKey(update.name, update.from)], `^${update.to}`)
  }
  await writeFile(manifestPath, manifest)
  return files
}

/** The ranges, such as `leaf@npm:^1.0.0`, that a Yarn 2+ lockfile resolves to each version. */
function yarnDescriptors(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>()
  let specs: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line && !line.startsWith(' ') && !line.startsWith('#') && line.endsWith(':')) {
      specs = line.slice(0, -1).replace(/^"|"$/g, '').split(/,\s*/)
      continue
    }
    const resolution = /^ {2}resolution: "?(.+?)"?$/.exec(line)
    const at = resolution ? resolution[1].indexOf('@npm:', 1) : -1
    if (!resolution || at < 0) continue
    const key = packageKey(resolution[1].slice(0, at), resolution[1].slice(at + '@npm:'.length))
    result.set(key, [...(result.get(key) ?? []), ...specs])
  }
  return result
}

// pip

const PIN = /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*)(\s*(?:\[[^\]]*\])?\s*==\s*)([^\s;#,\\]+)([^\n]*)$/

const normalizePypi = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/** Pins in a requirements file, by normalized name. */
function readPins(text: string): Map<string, { version: string; line: number; hashed: boolean }[]> {
  const pins = new Map<string, { version: string; line: number; hashed: boolean }[]>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = PIN.exec(lines[index])
    if (!match) continue
    let logical = lines[index]
    for (let next = index; /\\\r?$/.test(lines[next]) && next + 1 < lines.length; next++) logical += lines[next + 1]
    const name = normalizePypi(match[2])
    pins.set(name, [...(pins.get(name) ?? []), { version: match[4], line: index, hashed: /--hash[=\s]/.test(logical) }])
  }
  return pins
}

function pinnedPackages(text: string): LockedPackage[] {
  return [...readPins(text)].flatMap(([name, list]) => list.map((pin) => ({ name, version: pin.version, direct: true, dev: false, dependencies: [] })))
}

/**
 * Changes `name==old` to `name==new` and keeps the rest of the line. A requirement with `--hash`
 * stays as it is: a new version needs new hashes, which only the registry can give.
 */
function editRequirements(text: string, updates: Update[]): string {
  const lines = text.split('\n')
  const pins = readPins(text)
  for (const update of updates) {
    for (const pin of pins.get(normalizePypi(update.name)) ?? []) {
      if (pin.version !== update.from || pin.hashed) continue
      lines[pin.line] = lines[pin.line].replace(PIN, (_all, indent: string, name: string, operator: string, _version: string, rest: string) => `${indent}${name}${operator}${update.to}${rest}`)
    }
  }
  return lines.join('\n')
}

// The fix itself

type Update = DependencyFix['updates'][number]

function versionsByName(packages: LockedPackage[], normalize: (name: string) => string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const item of packages) {
    const name = normalize(item.name)
    result.set(name, (result.get(name) ?? new Set()).add(item.version))
  }
  return result
}

function changedPackages(before: LockedPackage[], after: LockedPackage[], normalize: (name: string) => string, ecosystem: Ecosystem): FixResult['changed'] {
  const byVersion = (a: string, b: string): number => compareVersions(ecosystem, a, b)
  const old = versionsByName(before, normalize)
  const now = versionsByName(after, normalize)
  const changed: FixResult['changed'] = []
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const removed = [...old.get(name) ?? []].filter((version) => !now.get(name)?.has(version)).sort(byVersion)
    const added = [...now.get(name) ?? []].filter((version) => !old.get(name)?.has(version)).sort(byVersion)
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      changed.push({ name, from: removed[index] ?? null, to: added[index] ?? null })
    }
  }
  return changed
}

function stillThere(packages: LockedPackage[], updates: Update[], normalize: (name: string) => string): Update[] {
  const keys = new Set(packages.map((item) => packageKey(normalize(item.name), item.version)))
  return updates.filter((update) => keys.has(packageKey(normalize(update.name), update.from)))
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').replace(/\.lock$/, '-lock') || 'update'
}

async function uniqueBranch(cwd: string, fix: DependencyFix): Promise<string> {
  const only = fix.updates.length === 1 ? fix.updates[0] : null
  const base = `chronicle/deps-${slugify(only ? `${only.name}-${only.to}` : `${fix.updates.length}-updates`)}`
  for (let attempt = 1; ; attempt++) {
    const branch = attempt === 1 ? base : `${base}-${attempt}`
    const { code } = await runGit(cwd, ['check-ref-format', '--branch', branch], { okCodes: [128] })
    if (code !== 0) throw new Error(t('Недопустимое имя ветки: {branch}', { branch }))
    if (!(await revParse(cwd, `refs/heads/${branch}`))) return branch
  }
}

async function readBlob(cwd: string, rev: string, path: string): Promise<string | null> {
  const { stdout, code } = await runGit(cwd, ['cat-file', 'blob', `${rev}:${path}`], { okCodes: [128] })
  return code === 0 ? stdout.toString('utf8') : null
}

/** What to do by hand when Yarn 1 cannot be made to leave packages and their scripts alone. */
function classicYarnMessage(fix: DependencyFix): string {
  const direct = fix.updates.filter((update) => update.direct).map((update) => `${update.name}@${update.to}`)
  const others = Object.fromEntries(fix.updates.filter((update) => !update.direct).map((update) => [update.name, update.to]))
  const steps = [
    ...(direct.length ? [`yarn upgrade ${direct.join(' ')}`] : []),
    ...(Object.keys(others).length ? [t('добавь в package.json "resolutions": {value} и выполни yarn install', { value: JSON.stringify(others) })] : [])
  ]
  return t('Yarn 1 не умеет обновлять только yarn.lock: он ставит пакеты и запускает их скрипты. Обнови вручную в папке проекта: {command}', { command: steps.join('; ') })
}

function commitMessage(applied: { name: string; from: string; to: string }[]): string {
  const subject = applied.length === 1 ? `Update ${applied[0].name} to ${applied[0].to}` : `Update ${applied.length} dependencies`
  if (applied.length === 1) return `${subject}\n`
  return `${subject}\n\n${applied.map((update) => `- ${update.name} ${update.from} -> ${update.to}`).join('\n')}\n`
}

/**
 * Updates dependencies on a new branch, leaving the working folder and the current branch as they
 * are. The work happens in a temporary worktree, and the result is an ordinary commit that the
 * person reviews, tests and pushes.
 *
 * Package managers change only the lockfile and run with install scripts off. Code from the
 * repository can still run: npm and pnpm read `.npmrc`, pnpm runs `.pnpmfile.cjs`, and Yarn runs the
 * release that `yarnPath` names and the plugins in `.yarnrc.yml`. The interface must warn about this
 * before calling it on a repository the person does not trust.
 */
export async function fixDependencies(cwd: string, fix: DependencyFix, options: { base?: string } = {}): Promise<FixResult> {
  validateFix(fix)
  const baseRev = options.base ?? 'HEAD'
  if (!baseRev || baseRev.startsWith('-')) throw new Error(`${t('Недопустимая ссылка')}: ${baseRev}`)
  const base = await revParse(cwd, baseRev)
  if (!base) throw new Error(t('Не найдено: {ref}', { ref: baseRev }))
  const lockText = await readBlob(cwd, base, fix.lockfile)
  if (lockText === null) throw new Error(t('В коммите нет файла {path}', { path: fix.lockfile }))
  if (fix.manager === 'yarn' && !/^__metadata:/m.test(lockText)) throw new Error(classicYarnMessage(fix))

  const branch = await uniqueBranch(cwd, fix)
  const folder = await mkdtemp(join(tmpdir(), 'chronicle-deps-'))
  const worktree = join(folder, 'tree')
  await git(cwd, ['worktree', 'add', '--detach', '--', worktree, base])
  try {
    const projectPath = posix.dirname(fix.lockfile)
    const project = join(worktree, projectPath)
    const lockPath = join(worktree, fix.lockfile)
    const normalize = fix.manager === 'pip' ? normalizePypi : (name: string): string => name
    const read = async (): Promise<LockedPackage[]> => {
      const text = await readFile(lockPath, 'utf8')
      if (fix.manager === 'pip') return pinnedPackages(text)
      const manifest = await readFile(join(project, 'package.json'), 'utf8').catch(() => null)
      return parseLockfile(fix.lockfile, text, manifest).packages
    }
    const before = await read()
    const pending = stillThere(before, fix.updates, normalize)
    if (!pending.length) throw new Error(t('Ничего не обновлено: в {path} уже нет этих версий.', { path: fix.lockfile }))
    const touched = new Set([fix.lockfile])

    if (fix.manager === 'pip') {
      await writeFile(lockPath, editRequirements(lockText, pending))
    } else {
      const manager = fix.manager as NodeManager
      const manifestPath = join(project, 'package.json')
      let manifest = await readFile(manifestPath, 'utf8').catch(() => null)
      if (manifest === null) throw new Error(t('Рядом с {path} нет package.json', { path: fix.lockfile }))
      const relative = (file: string): string => (projectPath === '.' ? file : `${projectPath}/${file}`)
      // pnpm update may also rewrite a range in the manifest, which must go with the lockfile.
      touched.add(relative('package.json'))
      // Only the version the project itself asks for is raised: `leaf: ^2.0.0` stays when the old
      // version is a copy of leaf that another package brings.
      const directOld = new Set(before.filter((item) => item.direct).map((item) => packageKey(item.name, item.version)))
      let bumped = false
      for (const update of pending.filter((item) => directOld.has(packageKey(item.name, item.from)))) {
        const next = bumpSpecifier(manifest, update.name, update.to)
        if (next === null) continue
        manifest = next
        bumped = true
      }
      if (bumped) {
        await writeFile(manifestPath, manifest)
        await runPackageManager(project, installCommand(manager))
      }
      let left = stillThere(await read(), pending, normalize)
      if (left.length) {
        await runPackageManager(project, updateCommand(manager, [...new Set(left.map((update) => update.name))]))
        left = stillThere(await read(), left, normalize)
      }
      // npm refuses an override that applies to a dependency the manifest lists itself, and an old
      // version that the project asks for directly is the manifest's to change.
      const overridable = left.filter((update) => !(directOld.has(packageKey(update.name, update.from)) && listedInManifest(manifest!, update.name)))
      if (overridable.length) {
        const current = await readFile(lockPath, 'utf8')
        for (const file of await addOverrides(manager, project, overridable, current)) touched.add(relative(file))
        await runPackageManager(project, installCommand(manager))
      }
    }

    const after = await read()
    const missed = stillThere(after, pending, normalize)
    const changed = changedPackages(before, after, normalize, fix.manager === 'pip' ? 'PyPI' : 'npm')
    const status = await git(worktree, ['status', '--porcelain', '--', ...touched])
    if (!status.trim() || missed.length === pending.length) {
      const names = missed.map((update) => packageKey(update.name, update.from)).join(', ')
      throw new Error(t('Ничего не обновлено: {manager} оставил прежние версии ({names}). Возможно, нужной версии нет в реестре или её не допускают другие пакеты.', { manager: fix.manager, names }))
    }
    const applied = pending.filter((update) => !missed.includes(update)).map((update) => {
      const added = [...versionsByName(after, normalize).get(normalize(update.name)) ?? []]
        .filter((version) => !versionsByName(before, normalize).get(normalize(update.name))?.has(version))
      return { name: update.name, from: update.from, to: added.length === 1 ? added[0] : update.to }
    })
    await git(worktree, ['add', '--', ...touched])
    // Hooks expect installed packages, which a lockfile-only update leaves out; the person runs them on review.
    await git(worktree, ['commit', '--no-verify', '--file=-', '--cleanup=whitespace'], { input: commitMessage(applied) })
    const commit = await gitLine(worktree, ['rev-parse', 'HEAD'])
    await moveRefs(cwd, [{ ref: `refs/heads/${branch}`, before: null, after: commit }], t('Обновление зависимостей: {branch}', { branch }))
    return { branch, commit, changed, missed: missed.map((update) => packageKey(update.name, update.from)) }
  } finally {
    await runGit(cwd, ['worktree', 'remove', '--force', '--', worktree], { okCodes: [128] })
    await rm(folder, { recursive: true, force: true })
    await runGit(cwd, ['worktree', 'prune'])
  }
}
