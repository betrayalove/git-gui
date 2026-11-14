import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import { AskpassServer } from '../core/askpass'
import { checkGitVersion, configureGit, withoutPrompts } from '../core/git'
import { PromptBroker } from '../core/prompt-broker'
import { checkKey, checkRemote, createKey, derivePublicKey, listKeys, probeHost, verifyPassphrase } from '../core/ssh'
import { classifyAccessError, issueSummary, type AccessPrompt, type PromptReply } from '../shared/access'
import { cloneRepository, initRepository } from '../core/ops'
import { isRepository, repoRoot } from '../core/read'
import { listSchedules, publishDue, waitingNotice } from '../core/schedule'
import { checkForUpdate } from '../core/updates'
import { api, type AppApi, type ApiMethod } from './api'
import { PassphraseStore } from './passphrases'
import { isLanguage, language, languageForLocale, setLanguage, t, type Language } from '../shared/i18n'
import { DEFAULT_AUTO_FETCH_MINUTES, isAutoFetchMinutes, isTheme, type AutoFetchMinutes, type Theme } from '../shared/types'

const here = fileURLToPath(new URL('.', import.meta.url))
// The portable Windows build unpacks to a temporary folder and names its real location here.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
if (portableDir) app.setPath('userData', join(portableDir, 'Chronicle Data'))
const statePath = (): string => join(app.getPath('userData'), 'state.json')

/**
 * Date fields and the system's own menus follow Chromium's locale, which can only be set before
 * the app is ready. So the chosen language is read here once, ahead of the rest of the settings.
 */
function applyChosenLocale(): void {
  try {
    const saved = (JSON.parse(readFileSync(statePath(), 'utf8')) as { language?: unknown }).language
    if (isLanguage(saved)) app.commandLine.appendSwitch('lang', saved === 'en' ? 'en-US' : 'ru')
  } catch {
    // No settings yet: the system locale stays.
  }
}
applyChosenLocale()
const TICK_MS = 30_000
const RECENT_LIMIT = 20

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const openRepos = new Set<string>()
let recent: string[] = []
const HIDDEN_FLAG = '--chronicle-hidden'
let startedHidden = false
let updateChecks = true
let autoFetchMinutes: AutoFetchMinutes = DEFAULT_AUTO_FETCH_MINUTES
let dependencyConsent = false
/** Null until the person picks one: until then the language follows the system. */
let chosenLanguage: Language | null = null
let theme: Theme = 'system'
const PROMPT_TIMEOUT_MS = 5 * 60_000
const warnedWaiting = new Set<string>()
const openPrompts = new Map<string, (reply: PromptReply | null) => void>()
let passphrases: PassphraseStore
let askpass: AskpassServer
let broker: PromptBroker

async function loadState(): Promise<void> {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8')) as {
      recent?: string[]; known?: string[]; updateChecks?: boolean; dependencyConsent?: boolean; language?: unknown; theme?: unknown; autoFetchMinutes?: unknown
    }
    recent = state.recent ?? []
    updateChecks = state.updateChecks ?? true
    autoFetchMinutes = isAutoFetchMinutes(state.autoFetchMinutes) ? state.autoFetchMinutes : DEFAULT_AUTO_FETCH_MINUTES
    dependencyConsent = state.dependencyConsent ?? false
    chosenLanguage = isLanguage(state.language) ? state.language : null
    theme = isTheme(state.theme) ? state.theme : 'system'
    for (const repo of state.known ?? []) openRepos.add(repo)
  } catch {
    recent = []
  }
  for (const repo of recent) openRepos.add(repo)
  setLanguage(chosenLanguage ?? languageForLocale(app.getLocale()))
  nativeTheme.themeSource = theme
}

async function saveState(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  // `known` outlives the recent list, so a pending publish still runs after its repository scrolls off.
  await writeFile(statePath(), JSON.stringify({ recent, known: [...openRepos], updateChecks, dependencyConsent, language: chosenLanguage ?? undefined, theme, autoFetchMinutes }, null, 2))
}

async function rememberRepo(path: string): Promise<string> {
  if (!(await isRepository(path))) throw new Error(t('Это не git-репозиторий: {path}', { path }))
  const root = await repoRoot(path)
  openRepos.add(root)
  recent = [root, ...recent.filter((item) => item !== root)].slice(0, RECENT_LIMIT)
  await saveState()
  return root
}

/** Apps started from Finder get a minimal PATH, without Homebrew git or the ssh-agent socket. */
async function adoptLoginShellEnv(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  try {
    const shellPath = process.env.SHELL || '/bin/zsh'
    const { stdout } = await promisify(execFile)(shellPath, ['-ilc', 'env'], { timeout: 5000 })
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const line of stdout.split('\n')) {
      const match = /^(PATH|SSH_AUTH_SOCK|GIT_SSH_COMMAND)=(.*)$/.exec(line)
      if (match) env[match[1]] = match[2]
    }
    configureGit({ env })
  } catch {
    // The inherited environment still works for most setups.
  }
}

/** Shows a question from git or ssh. An unanswered one is cancelled, so a command never hangs for good. */
function askPerson(prompt: AccessPrompt): Promise<PromptReply | null> {
  if (!window) return Promise.resolve(null)
  window.show()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      openPrompts.delete(prompt.id)
      window?.webContents.send('chronicle:prompt-closed', prompt.id)
      resolve(null)
    }, PROMPT_TIMEOUT_MS)
    openPrompts.set(prompt.id, (reply) => {
      clearTimeout(timer)
      openPrompts.delete(prompt.id)
      resolve(reply)
    })
    window!.webContents.send('chronicle:prompt', prompt)
  })
}

async function startPrompts(): Promise<void> {
  passphrases = new PassphraseStore(join(app.getPath('userData'), 'key-passwords.json'))
  await passphrases.load()
  askpass = new AskpassServer((request) => broker.handle(request))
  broker = new PromptBroker(askPerson, passphrases, (path, value) => verifyPassphrase(path, value, askpass))
  await askpass.start(join(app.getPath('userData'), 'askpass'))
  configureGit({ promptEnv: () => askpass.env() })
}

function trayIcon(): Electron.NativeImage {
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = Math.hypot(x - 7.5, y - 7.5) <= 5.5
      bitmap.set(inside ? [0x3c, 0xa8, 0xf5, 0xff] : [0, 0, 0, 0], (y * size + x) * 4)
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

async function pendingCount(): Promise<number> {
  let count = 0
  for (const repo of openRepos) {
    const schedules = await listSchedules(repo).catch(() => [])
    count += schedules.filter((item) => item.state === 'pending').length
  }
  return count
}

async function syncTray(): Promise<void> {
  const pending = await pendingCount()
  // After a hidden start at login the tray is the only way to reach the app.
  if (!pending && !startedHidden) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(trayIcon())
    tray.on('click', showWindow)
  }
  tray.setToolTip(pending ? t('Chronicle: запланировано публикаций: {pending}', { pending }) : 'Chronicle')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('Запланировано публикаций: {pending}', { pending }), enabled: false },
    { label: t('Открыть Chronicle'), click: showWindow },
    { type: 'separator' },
    { label: t('Выйти'), click: () => { quitting = true; app.quit() } }
  ]))
}

async function tick(): Promise<void> {
  for (const repo of openRepos) {
    let results: Awaited<ReturnType<typeof publishDue>> = []
    try {
      results = await withoutPrompts(() => publishDue(repo))
    } catch (error) {
      console.error(`Publish failed for ${repo}:`, error)
    }
    for (const result of results) {
      if (result.state === 'pending') {
        // It stays pending and retries by itself, but someone has to fix the cause, and only once needs telling.
        const notice = waitingNotice(result)
        if (notice && !warnedWaiting.has(result.id) && Notification.isSupported()) {
          warnedWaiting.add(result.id)
          new Notification(notice).show()
        }
        continue
      }
      if (Notification.isSupported()) {
        const issue = result.error ? classifyAccessError(result.error) : null
        new Notification({
          title: result.state === 'done' ? t('Опубликовано: {branch}', { branch: result.branch }) : t('Не удалось опубликовать: {branch}', { branch: result.branch }),
          body: (issue && issueSummary(issue)) ?? result.error ?? result.note ?? t('Коммитов: {commitsCount}', { commitsCount: result.commits.length })
        }).show()
      }
    }
    if (results.length) window?.webContents.send('chronicle:changed', repo)
  }
  await syncTray()
}

function showWindow(): void {
  if (window) {
    window.show()
    window.focus()
  } else {
    createWindow()
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0f12' : '#eff0f3',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#00000000', symbolColor: '#9a9ca5', height: 44 } }),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => { window = null })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(here, '../renderer/index.html'))
}

const appHandlers: AppApi = {
  recentRepos: async () => recent,
  pickRepository: async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: t('Открыть репозиторий') })
    return result.canceled ? null : rememberRepo(result.filePaths[0])
  },
  openRepository: rememberRepo,
  forgetRepository: async (path) => {
    const schedules = await listSchedules(path).catch(() => [])
    if (schedules.some((item) => item.state === 'pending')) {
      throw new Error(t('В этом репозитории есть запланированные публикации. Сначала отмени их.'))
    }
    recent = recent.filter((item) => item !== path)
    openRepos.delete(path)
    await saveState()
  },
  pickFolder: async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  },
  cloneRepository: async (url, parent, directory, keyPath) => rememberRepo(await cloneRepository(url, parent, directory, keyPath)),
  initRepository: async (path) => {
    await initRepository(path)
    return rememberRepo(path)
  },
  copyText: async (text) => clipboard.writeText(text),
  revealPath: async (path) => shell.showItemInFolder(path),
  openExternal: async (url) => {
    if (!url.startsWith('https://')) throw new Error(t('Адрес не открыт: {url}', { url }))
    await shell.openExternal(url)
  },
  sshListKeys: (host) => listKeys(host),
  sshProbeHost: probeHost,
  sshCheckKey: (key, target, interactive) => checkKey(key, target, interactive),
  sshDerivePublicKey: derivePublicKey,
  sshCreateKey: async (passphrase, remember) => {
    const path = await createKey(passphrase, askpass)
    if (passphrase) await broker.remember(path, passphrase, remember)
    return path
  },
  sshCheckRemote: async (repo, url, keyPath) => {
    if (repo !== null && !openRepos.has(repo)) throw new Error(t('Репозиторий не открыт'))
    return checkRemote(repo, url, keyPath)
  },
  answerPrompt: async (id, reply) => openPrompts.get(id)?.(reply),
  savedPassphrases: async () => ({ available: passphrases.available(), count: passphrases.count() }),
  forgetPassphrases: async () => {
    broker.clearSession()
    await passphrases.clear()
  },
  checkForUpdates: () => checkForUpdate(app.getVersion()),
  updateChecksEnabled: async () => updateChecks && app.isPackaged,
  setUpdateChecksEnabled: async (enabled) => {
    updateChecks = enabled
    await saveState()
  },
  autoFetchMinutes: async () => autoFetchMinutes,
  setAutoFetchMinutes: async (minutes) => {
    if (!isAutoFetchMinutes(minutes)) throw new Error(t('Недопустимый интервал: {value}', { value: String(minutes) }))
    autoFetchMinutes = minutes
    await saveState()
  },
  dependencyConsent: async () => dependencyConsent,
  setDependencyConsent: async (agreed) => {
    dependencyConsent = agreed
    await saveState()
  },
  autostart: async () => ({
    available: app.isPackaged && !portableDir,
    enabled: app.isPackaged && !portableDir && app.getLoginItemSettings().openAtLogin
  }),
  preferences: async () => ({ language: language(), theme }),
  setLanguage: async (next) => {
    if (!isLanguage(next)) throw new Error(t('Неизвестный язык: {next}', { next: String(next) }))
    chosenLanguage = next
    setLanguage(next)
    await saveState()
    await syncTray()
    // Every text, including those kept in constants, has to be drawn again. The page itself may not
    // navigate, so the reload comes from here, once this call has answered.
    setImmediate(() => window?.webContents.reload())
  },
  setTheme: async (next) => {
    if (!isTheme(next)) throw new Error(t('Неизвестная тема: {next}', { next: String(next) }))
    theme = next
    nativeTheme.themeSource = next
    await saveState()
  },
  setAutostart: async (enabled) => {
    if (!app.isPackaged || portableDir) throw new Error(t('Автозапуск доступен только в установленном приложении'))
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? [HIDDEN_FLAG] : [] })
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function registerIpc(): void {
  // The window asks before its scripts run, so every text is in the right language from the start.
  ipcMain.on('chronicle:language', (event) => { event.returnValue = language() })
  ipcMain.handle('chronicle:repo', async (_event, method: ApiMethod, args: unknown[]) => {
    try {
      if (!Object.hasOwn(api, method)) throw new Error(t('Неизвестный метод: {method}', { method }))
      const repo = args[0]
      if (typeof repo !== 'string' || !openRepos.has(repo)) throw new Error(t('Репозиторий не открыт'))
      const handler = api[method] as (...values: unknown[]) => Promise<unknown>
      const value = await handler(...args)
      if (method === 'schedulePublish' || method === 'cancelSchedule') void syncTray()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
  ipcMain.handle('chronicle:app', async (_event, method: keyof AppApi, args: unknown[]) => {
    try {
      if (!Object.hasOwn(appHandlers, method)) throw new Error(t('Неизвестный метод: {method}', { method }))
      const handler = appHandlers[method] as (...values: unknown[]) => Promise<unknown>
      return { ok: true, value: await handler(...args) }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  })
}

// A second instance would run its own publish timer, so only one may live.
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', showWindow)

void app.whenReady().then(async () => {
  await adoptLoginShellEnv()
  await loadState()
  await startPrompts()
  registerIpc()
  startedHidden = process.argv.includes(HIDDEN_FLAG) || (app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin)
  try {
    await checkGitVersion()
  } catch (error) {
    dialog.showErrorBox(t('Git не подходит'), errorText(error))
  }
  if (!startedHidden) createWindow()
  await tick()
  setInterval(() => void tick(), TICK_MS)
  app.on('activate', showWindow)
})

app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => void askpass?.stop())

// A pending publish has to survive a closed window, so the app stays in the tray until it is done.
app.on('window-all-closed', () => {
  void pendingCount().then((pending) => {
    if (pending > 0 && !quitting) void syncTray()
    else if (process.platform !== 'darwin' || quitting) app.quit()
  })
})
