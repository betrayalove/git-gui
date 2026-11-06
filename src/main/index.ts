import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import { checkGitVersion, configureGit } from '../core/git'
import { cloneRepository, initRepository } from '../core/ops'
import { isRepository, repoRoot } from '../core/read'
import { listSchedules, publishDue } from '../core/schedule'
import { api, type AppApi, type ApiMethod } from './api'

const here = fileURLToPath(new URL('.', import.meta.url))
const statePath = (): string => join(app.getPath('userData'), 'state.json')
const TICK_MS = 30_000
const RECENT_LIMIT = 20

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
const openRepos = new Set<string>()
let recent: string[] = []

async function loadState(): Promise<void> {
  try {
    const state = JSON.parse(await readFile(statePath(), 'utf8')) as { recent?: string[]; known?: string[] }
    recent = state.recent ?? []
    for (const repo of state.known ?? []) openRepos.add(repo)
  } catch {
    recent = []
  }
  for (const repo of recent) openRepos.add(repo)
}

async function saveState(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  // `known` outlives the recent list, so a pending publish still runs after its repository scrolls off.
  await writeFile(statePath(), JSON.stringify({ recent, known: [...openRepos] }, null, 2))
}

async function rememberRepo(path: string): Promise<string> {
  if (!(await isRepository(path))) throw new Error(`Это не git-репозиторий: ${path}`)
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
      const match = /^(PATH|SSH_AUTH_SOCK|GIT_SSH_COMMAND|GIT_ASKPASS)=(.*)$/.exec(line)
      if (match) env[match[1]] = match[2]
    }
    configureGit({ env })
  } catch {
    // The inherited environment still works for most setups.
  }
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
  if (!pending) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    tray = new Tray(trayIcon())
    tray.on('click', showWindow)
  }
  tray.setToolTip(`Chronicle: запланировано публикаций: ${pending}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Запланировано публикаций: ${pending}`, enabled: false },
    { label: 'Открыть Chronicle', click: showWindow },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit() } }
  ]))
}

async function tick(): Promise<void> {
  for (const repo of openRepos) {
    let results: Awaited<ReturnType<typeof publishDue>> = []
    try {
      results = await publishDue(repo)
    } catch (error) {
      console.error(`Publish failed for ${repo}:`, error)
    }
    for (const result of results) {
      if (result.state === 'pending') continue
      if (Notification.isSupported()) {
        new Notification({
          title: result.state === 'done' ? `Опубликовано: ${result.branch}` : `Не удалось опубликовать: ${result.branch}`,
          body: result.error ?? result.note ?? `Коммитов: ${result.commits.length}`
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
    backgroundColor: '#101114',
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
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], title: 'Открыть репозиторий' })
    return result.canceled ? null : rememberRepo(result.filePaths[0])
  },
  openRepository: rememberRepo,
  forgetRepository: async (path) => {
    const schedules = await listSchedules(path).catch(() => [])
    if (schedules.some((item) => item.state === 'pending')) {
      throw new Error('В этом репозитории есть запланированные публикации. Сначала отмени их.')
    }
    recent = recent.filter((item) => item !== path)
    openRepos.delete(path)
    await saveState()
  },
  pickFolder: async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  },
  cloneRepository: async (url, parent, directory) => rememberRepo(await cloneRepository(url, parent, directory)),
  initRepository: async (path) => {
    await initRepository(path)
    return rememberRepo(path)
  },
  copyText: async (text) => clipboard.writeText(text)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function registerIpc(): void {
  ipcMain.handle('chronicle:repo', async (_event, method: ApiMethod, args: unknown[]) => {
    try {
      if (!Object.hasOwn(api, method)) throw new Error(`Неизвестный метод: ${method}`)
      const repo = args[0]
      if (typeof repo !== 'string' || !openRepos.has(repo)) throw new Error('Репозиторий не открыт')
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
      if (!Object.hasOwn(appHandlers, method)) throw new Error(`Неизвестный метод: ${method}`)
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
  registerIpc()
  try {
    await checkGitVersion()
  } catch (error) {
    dialog.showErrorBox('Git не подходит', errorText(error))
  }
  createWindow()
  await tick()
  setInterval(() => void tick(), TICK_MS)
  app.on('activate', showWindow)
})

app.on('before-quit', () => { quitting = true })

// A pending publish has to survive a closed window, so the app stays in the tray until it is done.
app.on('window-all-closed', () => {
  void pendingCount().then((pending) => {
    if (pending > 0 && !quitting) void syncTray()
    else if (process.platform !== 'darwin' || quitting) app.quit()
  })
})
