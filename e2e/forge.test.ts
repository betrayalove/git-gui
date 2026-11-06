import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { startMockForge, type MockState } from '../tests/forge-mock'

const shots = process.env.CHRONICLE_SHOTS
const TOKEN = 'glpat-mock-secret-value'

describe('Chronicle with a GitLab server', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-forge-'))
  const repo = join(root, 'project')
  const bare = join(root, 'server.git')
  const userData = join(root, 'data')
  let app: ElectronApplication
  let page: Page
  let server: Server
  let host: string
  let state: MockState
  const shot = async (name: string): Promise<void> => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }
  const settled = async (): Promise<void> => {
    await page.waitForTimeout(50)
    await page.locator('.busy').waitFor({ state: 'detached' })
  }

  beforeAll(async () => {
    mkdirSync(repo)
    mkdirSync(bare)
    mkdirSync(userData)
    await git(bare, ['init', '--bare', '-b', 'main'])
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['config', 'user.name', 'Test'])
    await git(repo, ['config', 'user.email', 'test@example.com'])
    await git(repo, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'a.txt'), '1\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'Начало'])
    await git(repo, ['remote', 'add', 'origin', bare])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'main'])
    await git(repo, ['switch', '-c', 'feature'])
    writeFileSync(join(repo, 'b.txt'), '2\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'Новая функция'])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'feature'])
    await git(repo, ['switch', 'main'])
    state = {
      kind: 'gitlab', token: TOKEN, bare, defaultBranch: 'main', log: [], rulesets: {},
      protections: { main: { allowForcePush: false } },
      requests: [{ id: 1, source: 'feature', target: 'main', title: 'Добавить функцию' }]
    }
    const started = await startMockForge(state)
    server = started.server
    host = started.host
    const webUrl = `http://${host}/team/project.git`
    await git(repo, ['config', 'remote.origin.url', webUrl])
    await git(repo, ['config', `url.${bare}.insteadOf`, webUrl])
    await git(repo, ['fetch', '-q', 'origin'])
    await git(repo, ['remote', 'set-head', 'origin', 'main'])
    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo] }))
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' }
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.recent-row button').first().click()
    await page.locator('.commit-row', { hasText: 'Начало' }).waitFor()
  })

  afterAll(async () => {
    await app?.close()
    server?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects a wrong token and stores nothing', async () => {
    await page.getByRole('button', { name: 'Настройки' }).click()
    await page.locator('.segmented button', { hasText: 'GitLab' }).click()
    await page.getByLabel('Адрес сервера').fill(host)
    await page.getByLabel('Токен доступа').fill('wrong-token')
    await page.getByRole('button', { name: 'Подключить', exact: true }).click()
    await page.getByText('Токен не подошёл').waitFor()
    expect(existsSync(join(userData, 'accounts.json'))).toBe(false)
  })

  it('connects an account and keeps the token away from disk and the interface', async () => {
    await page.getByLabel('Токен доступа').fill(TOKEN)
    await page.getByRole('button', { name: 'Подключить', exact: true }).click()
    await page.locator('.account-row', { hasText: 'mock-user' }).waitFor()
    await shot('20-settings')
    const onDisk = readFileSync(join(userData, 'accounts.json'), 'utf8')
    expect(onDisk).toContain('mock-user')
    expect(onDisk).not.toContain(TOKEN)
    const fromInterface = await page.evaluate(() => window.chronicle.app('accounts'))
    expect(JSON.stringify(fromInterface)).not.toContain(TOKEN)
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click()
  })

  it('lists Merge Requests', async () => {
    await page.locator('.side-nav button', { hasText: 'Merge Requests' }).click()
    await page.locator('.request-row', { hasText: 'Добавить функцию' }).waitFor()
    await shot('21-requests')
  })

  it('creates a Merge Request', async () => {
    await git(repo, ['switch', '-c', 'second'])
    writeFileSync(join(repo, 'c.txt'), '3\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'Ещё функция'])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'second'])
    await page.getByRole('button', { name: 'Обновить' }).click()
    await page.waitForTimeout(5500)
    await page.getByRole('button', { name: 'Новый', exact: true }).click()
    await page.getByLabel('Заголовок').fill('Второй запрос')
    await shot('22-new-request')
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    await expect.poll(() => state.requests.map((item) => item.title)).toContain('Второй запрос')
    expect(state.requests.at(-1)).toMatchObject({ source: 'second', target: 'main' })
    await settled()
    await page.locator('.request-row', { hasText: 'Второй запрос' }).waitFor()
    await page.locator('.request-row', { hasText: '!2' }).waitFor()
  })

  it('warns before a force-push to a protected branch', async () => {
    await git(repo, ['switch', 'main'])
    await git(repo, ['commit', '--amend', '-q', '-m', 'Начало, исправлено'])
    await page.waitForTimeout(5500)
    await page.getByRole('button', { name: 'Push' }).click()
    await page.getByText('force-push на неё запрещён').waitFor()
    await shot('23-protected')
    await page.getByRole('button', { name: 'Отмена' }).click()
    await git(repo, ['fetch', '-q', 'origin'])
    await git(repo, ['reset', '-q', '--hard', 'origin/main'])
    await page.waitForTimeout(5500)
  })

  it('renames the default branch: requests, protection and default all move', async () => {
    await page.locator('.side-item', { hasText: 'main' }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Переименовать…' }).click()
    await page.getByLabel('Новое имя').fill('trunk')
    await page.getByText('В GitLab нет переименования').waitFor()
    await page.getByText('Перейдут на новое имя: !1, !2').waitFor()
    await shot('24-rename-preview')
    await page.getByRole('button', { name: 'Переименовать', exact: true }).click()
    await expect.poll(() => state.defaultBranch).toBe('trunk')
    await expect.poll(() => git(bare, ['branch', '--list', '--format=%(refname:short)'])).not.toContain('main')
    expect(state.requests.every((item) => item.target === 'trunk')).toBe(true)
    expect(Object.keys(state.protections)).toEqual(['trunk'])
    await expect.poll(() => gitLine(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('trunk')
    expect(await gitLine(repo, ['rev-parse', '--abbrev-ref', 'trunk@{upstream}'])).toBe('origin/trunk')
    await settled()
  })

  it('changes the default branch from the remote list', async () => {
    await page.locator('.side-item', { hasText: 'second' }).nth(1).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Сделать основной на сервере…' }).click()
    await page.getByRole('button', { name: 'Сделать основной' }).click()
    await expect.poll(() => state.defaultBranch).toBe('second')
    await settled()
  })

  it('disconnects the account', async () => {
    await page.getByRole('button', { name: 'Настройки' }).click()
    await page.getByRole('button', { name: 'Отключить' }).click()
    await page.locator('.account-row').waitFor({ state: 'detached' })
    expect(readFileSync(join(userData, 'accounts.json'), 'utf8')).not.toContain('mock-user')
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click()
  })
})
