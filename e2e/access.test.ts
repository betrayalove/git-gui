import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { sshdFailure, sshTool, startSshServer, writeClientConfig, type SshServer } from '../tests/ssh-server'

const shots = process.env.CHRONICLE_SHOTS
const root = mkdtempSync(join(tmpdir(), 'chronicle-access-'))
const serverDir = join(root, 'server')
mkdirSync(serverDir)
const server: SshServer | null = await startSshServer(serverDir)

it.runIf(process.env.CHRONICLE_REQUIRE_SSHD)('has a real ssh server to test against', () => {
  expect(sshdFailure).toBe('')
})
const bare = join(serverDir, 'project.git')

interface Launched {
  app: ElectronApplication
  page: Page
  repo: string
  userData: string
  home: string
  opened: () => Promise<string[]>
  copied: () => Promise<string[]>
  /** Calls that can show a system dialog on macOS and, if synchronous, freeze the app. */
  keychain: () => Promise<{ sync: number; any: number }>
}

/** Starts the app on a repository whose remote is the real sshd, with its own empty ~/.ssh. */
async function launch(name: string, prepare?: (home: string) => void, knownHost = false): Promise<Launched> {
  const dir = join(root, name)
  const home = join(dir, 'home')
  const userData = join(dir, 'data')
  const repo = join(dir, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData)
  prepare?.(home)
  const clientDir = join(dir, 'client')
  mkdirSync(clientDir)
  const config = writeClientConfig(clientDir, home)
  if (knownHost) {
    const hostKey = readFileSync(join(serverDir, 'host_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(join(clientDir, 'known_hosts'), `[127.0.0.1]:${server!.port} ${hostKey}\n`)
  }
  const globalConfig = join(dir, 'gitconfig')
  writeFileSync(globalConfig, `[core]\n\tsshCommand = ssh -F '${config.replaceAll('\\', '/')}'\n`)
  await git(dir, ['init', '-q', '-b', 'main', repo])
  await git(repo, ['config', 'user.name', 'Test'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(repo, 'a.txt'), '1\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-q', '-m', 'Начало'])
  await git(repo, ['remote', 'add', 'origin', server!.url(bare)])
  writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo] }))
  const { SSH_AUTH_SOCK: _agent, ...env } = process.env
  const app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
    env: {
      ...env as Record<string, string>,
      ELECTRON_RENDERER_URL: '',
      CHRONICLE_SSH_HOME: home,
      CHRONICLE_SSH_CONFIG: config,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1'
    }
  })
  // Tests must not open the real browser or change the real clipboard.
  await app.evaluate(({ shell, clipboard }) => {
    const box = globalThis as unknown as { opened: string[]; copied: string[] }
    box.opened = []
    box.copied = []
    shell.openExternal = async (url: string) => { box.opened.push(url) }
    clipboard.writeText = async (text: string) => { box.copied.push(text) }
  })
  await app.evaluate(({ safeStorage }) => {
    const box = globalThis as unknown as { keychain: { sync: number; any: number } }
    box.keychain = { sync: 0, any: 0 }
    const store = safeStorage as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['isEncryptionAvailable', 'encryptString', 'decryptString', 'isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
      const original = store[name].bind(safeStorage)
      store[name] = (...args: unknown[]) => {
        box.keychain.any++
        if (!name.includes('Async')) box.keychain.sync++
        return original(...args)
      }
    }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('.recent-row button').first().click()
  await page.locator('.commit-row', { hasText: 'Начало' }).waitFor()
  return {
    app, page, repo, userData, home,
    opened: () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened),
    copied: () => app.evaluate(() => (globalThis as unknown as { copied: string[] }).copied),
    keychain: () => app.evaluate(() => (globalThis as unknown as { keychain: { sync: number; any: number } }).keychain)
  }
}

function makeKey(home: string, name: string, passphrase: string, comment: string): string {
  mkdirSync(join(home, '.ssh'), { recursive: true })
  const path = join(home, '.ssh', name)
  execFileSync(sshTool('ssh-keygen'), ['-q', '-t', 'ed25519', '-f', path, '-N', passphrase, '-C', comment])
  return readFileSync(`${path}.pub`, 'utf8')
}

const fetchButton = (page: Page) => page.getByRole('button', { name: 'Fetch' })

describe.skipIf(!server)('Connecting without an account', () => {
  beforeAll(async () => {
    const seed = join(root, 'seed')
    mkdirSync(seed)
    await git(seed, ['init', '-q', '-b', 'main'])
    await git(seed, ['config', 'user.name', 'Test'])
    await git(seed, ['config', 'user.email', 'test@example.com'])
    writeFileSync(join(seed, 's.txt'), 's\n')
    await git(seed, ['add', '.'])
    await git(seed, ['commit', '-q', '-m', 'С сервера'])
    mkdirSync(bare)
    await git(bare, ['clone', '-q', '--bare', seed, '.'])
  })

  afterAll(() => {
    server?.stop()
    rmSync(root, { recursive: true, force: true })
  })

  describe('with no key on the computer', () => {
    let run: Launched
    const shot = async (name: string): Promise<void> => {
      if (shots) await run.page.screenshot({ path: join(shots, `${name}.png`) })
    }

    beforeAll(async () => { run = await launch('fresh') })
    afterAll(async () => { await run?.app.close() })

    it('asks about the new server first, showing its fingerprint', async () => {
      await fetchButton(run.page).click()
      await run.page.getByRole('dialog', { name: 'Первое подключение к серверу' }).waitFor()
      await run.page.getByText('SHA256:').waitFor()
      await shot('30-host-key')
      await run.page.getByRole('button', { name: 'Доверять и подключиться' }).click()
    })

    it('offers to create a key when the server refuses', async () => {
      await run.page.getByRole('button', { name: 'Создать ключ' }).waitFor()
      await run.page.getByText('ещё не подключён').waitFor()
      await shot('31-no-key')
    })

    it('rejects a short or mismatched password', async () => {
      await run.page.getByLabel('Пароль ключа, необязательно').fill('abc')
      expect(await run.page.getByRole('button', { name: 'Создать ключ' }).isDisabled()).toBe(true)
      await run.page.getByLabel('Пароль ключа, необязательно').fill('длинный пароль')
      await run.page.getByLabel('Ещё раз').fill('другой')
      expect(await run.page.getByRole('button', { name: 'Создать ключ' }).isDisabled()).toBe(true)
      await run.page.getByLabel('Пароль ключа, необязательно').fill('')
      await run.page.getByLabel('Ещё раз').fill('')
    })

    it('creates a key and explains how to add it, for GitHub or GitLab', async () => {
      await run.page.getByRole('button', { name: 'Создать ключ' }).click()
      await run.page.getByRole('button', { name: 'Скопировать и открыть GitHub' }).waitFor()
      expect(readFileSync(join(run.home, '.ssh', 'id_ed25519.pub'), 'utf8')).toContain('ssh-ed25519')
      await run.page.getByText('Key type оставь Authentication Key').waitFor()
      await shot('32-add-github')
      await run.page.getByRole('group', { name: 'Сервер' }).getByRole('button', { name: 'GitLab' }).click()
      await run.page.getByText('Usage type оставь').waitFor()
      await shot('33-add-gitlab')
      await run.page.getByRole('button', { name: 'Скопировать и открыть GitLab' }).click()
      await expect.poll(run.opened).toEqual(['https://127.0.0.1/-/user_settings/ssh_keys'])
      const publicKey = readFileSync(join(run.home, '.ssh', 'id_ed25519.pub'), 'utf8').trim()
      expect(await run.copied()).toEqual([publicKey])
    })

    it('says so when the key is not on the server yet', async () => {
      await run.page.getByRole('button', { name: 'Проверить подключение' }).click()
      await run.page.getByText('Сервер пока не видит этот ключ').waitFor()
    })

    it('notices the added key on returning to the app, and repeats the failed action', async () => {
      server!.authorize(readFileSync(join(run.home, '.ssh', 'id_ed25519.pub'), 'utf8'))
      await run.page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await run.page.getByText('Подключено как tester').waitFor()
      await shot('34-connected')
      await run.page.getByRole('button', { name: 'Повторить действие' }).click()
      await run.page.getByText('Данные с сервера обновлены').waitFor()
      expect(await git(run.repo, ['branch', '-r'])).toContain('origin/main')
      expect(await gitLine(run.repo, ['config', '--local', '--default', '', '--get', 'core.sshCommand'])).toBe('')
    })

    it('shows the commit author and changes it for this repository only', async () => {
      await run.page.locator('.side-nav button', { hasText: 'Изменения' }).click()
      await run.page.locator('.commit-author', { hasText: 'test@example.com' }).click()
      await run.page.getByLabel('Имя').fill('Новый Автор')
      await run.page.getByLabel('Email').fill('new@example.com')
      await run.page.getByRole('button', { name: 'Сохранить' }).click()
      await run.page.locator('.commit-author', { hasText: 'new@example.com' }).waitFor()
      expect(await gitLine(run.repo, ['config', '--local', 'user.email'])).toBe('new@example.com')
      await run.page.locator('.side-nav button', { hasText: 'История' }).click()
    })
  })

  describe('with a key that has a password', () => {
    const passphrase = 'пароль от ключа'
    let run: Launched

    beforeAll(async () => {
      run = await launch('locked', (home) => server!.authorize(makeKey(home, 'id_ed25519', passphrase, 'locked')), true)
    })
    afterAll(async () => { await run?.app.close() })

    // Linux without a keyring would store passwords under a fixed key, so the app does not offer it.
    const canRemember = process.platform !== 'linux'

    it('leaves the system keychain alone until asked to remember', async () => {
      await run.page.getByRole('button', { name: 'Настройки' }).click()
      await run.page.getByRole('button', { name: 'Настроить SSH-ключ' }).waitFor()
      await run.page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click()
      expect(await run.keychain()).toEqual({ sync: 0, any: 0 })
    })

    it('asks for it, says when it is wrong, and offers to remember it', async () => {
      await fetchButton(run.page).click()
      const dialog = run.page.getByRole('dialog', { name: 'Пароль SSH-ключа' })
      await dialog.waitFor()
      await dialog.getByText('id_ed25519').waitFor()
      if (shots) await run.page.screenshot({ path: join(shots, '35-passphrase.png') })
      expect(await run.keychain()).toEqual({ sync: 0, any: 0 })
      await dialog.getByLabel('Пароль ключа').fill('неверный')
      await dialog.getByRole('button', { name: 'Продолжить' }).click()
      await run.page.getByText('Пароль не подошёл').waitFor()
      await dialog.getByLabel('Пароль ключа').fill(passphrase)
      if (canRemember) await run.page.getByText('Запомнить на этом компьютере').click()
      else expect(await run.page.getByText('Запомнить на этом компьютере').count()).toBe(0)
      await dialog.getByRole('button', { name: 'Продолжить' }).click()
      await run.page.getByText('Данные с сервера обновлены').waitFor()
    })

    it.runIf(canRemember)('uses only calls that cannot freeze the app', async () => {
      const calls = await run.keychain()
      expect(calls.any).toBeGreaterThan(0)
      expect(calls.sync).toBe(0)
    })

    it.runIf(canRemember)('keeps the saved password encrypted', () => {
      const onDisk = readFileSync(join(run.userData, 'key-passwords.json'), 'utf8')
      expect(onDisk).toContain('id_ed25519')
      expect(onDisk).not.toContain(passphrase)
    })

    it('does not ask again in the same session', async () => {
      await run.page.waitForTimeout(100)
      await fetchButton(run.page).click()
      await run.page.getByText('Данные с сервера обновлены').first().waitFor()
      expect(await run.page.getByRole('dialog', { name: 'Пароль SSH-ключа' }).count()).toBe(0)
    })

    it.runIf(canRemember)('can forget saved passwords', async () => {
      await run.page.getByRole('button', { name: 'Настройки' }).click()
      await run.page.getByRole('button', { name: /Забыть сохранённые пароли ключей: 1/ }).click()
      await expect.poll(() => readFileSync(join(run.userData, 'key-passwords.json'), 'utf8').includes('id_ed25519')).toBe(false)
      await run.page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click()
    })
  })

  describe('with a working key under an unusual name', () => {
    let run: Launched

    beforeAll(async () => {
      run = await launch('named', (home) => server!.authorize(makeKey(home, 'work_key', '', 'work')), true)
    })
    afterAll(async () => { await run?.app.close() })

    it('finds it, uses it, and ties it to this repository', async () => {
      await fetchButton(run.page).click()
      await run.page.getByText('Подключено как tester').waitFor()
      await run.page.getByText('закреплён за этим репозиторием').waitFor()
      if (shots) await run.page.screenshot({ path: join(shots, '36-existing-key.png') })
      expect(await gitLine(run.repo, ['config', '--local', 'core.sshCommand'])).toContain('work_key')
      await run.page.getByRole('button', { name: 'Повторить действие' }).click()
      await run.page.getByText('Данные с сервера обновлены').waitFor()
    })
  })

  describe('with keys the server does not know', () => {
    let run: Launched

    beforeAll(async () => {
      run = await launch('unknown', (home) => {
        makeKey(home, 'id_ed25519', '', 'first')
        makeKey(home, 'old_key', '', 'second')
      }, true)
    })
    afterAll(async () => { await run?.app.close() })

    it('offers the existing keys before creating a new one', async () => {
      await fetchButton(run.page).click()
      await run.page.locator('.key-row', { hasText: 'id_ed25519' }).waitFor()
      await run.page.locator('.key-row', { hasText: 'old_key' }).waitFor()
      await run.page.getByText('не добавлен на сервер').first().waitFor()
      if (shots) await run.page.screenshot({ path: join(shots, '37-choose-key.png') })
      await run.page.locator('.key-row', { hasText: 'old_key' }).click()
      await run.page.getByText('second').waitFor()
      await run.page.getByRole('button', { name: 'Создать новый ключ' }).click()
      await run.page.getByRole('button', { name: 'Создать ключ' }).click()
      await run.page.locator('.key-row', { hasText: 'id_ed25519_chronicle' }).waitFor()
    })
  })

  describe('from the settings, with no repository', () => {
    let run: Launched

    beforeAll(async () => { run = await launch('settings') })
    afterAll(async () => { await run?.app.close() })

    it('lets you choose GitHub or GitLab', async () => {
      await run.page.locator('.repo-switch').click()
      await run.page.getByRole('button', { name: 'Настройки' }).click()
      await run.page.getByRole('button', { name: 'Настроить SSH-ключ' }).click()
      await run.page.getByRole('dialog', { name: 'Подключение к github.com' }).waitFor()
      if (shots) await run.page.screenshot({ path: join(shots, '38-settings-github.png') })
      await run.page.getByRole('group', { name: 'Сервер' }).getByRole('button', { name: 'GitLab' }).click({ force: true })
      await run.page.getByRole('dialog', { name: 'Подключение к gitlab.com' }).waitFor()
    })
  })
})
