import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'

const shots = process.env.CHRONICLE_SHOTS

async function commitFile(dir: string, path: string, content: string, message: string, author = 'Ann Author <ann@example.com>'): Promise<void> {
  const full = join(dir, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  await git(dir, ['add', '--all'])
  await git(dir, ['commit', '-m', message, `--author=${author}`])
}

describe('Chronicle', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-e2e-'))
  const repo = join(root, 'demo-project')
  const bare = join(root, 'server.git')
  const userData = join(root, 'user-data')
  let app: ElectronApplication
  let page: Page
  const pageErrors: string[] = []

  const log = async (rev = 'HEAD'): Promise<string[]> => (await git(repo, ['log', '--format=%s', rev])).split('\n').filter(Boolean)
  const shot = async (name: string): Promise<void> => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }
  const row = (subject: string) => page.locator('.commit-row', { hasText: subject })

  /** Applies the open draft or plan and confirms the force-push that follows. */
  const applyAndPublish = async (): Promise<void> => {
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).waitFor()
    await page.getByText('Понимаю').click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).click()
    await expect.poll(async () => gitLine(bare, ['rev-parse', 'main'])).toBe(await gitLine(repo, ['rev-parse', 'HEAD']))
    await page.locator('.modal').waitFor({ state: 'detached' })
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
    await commitFile(repo, 'README.md', '# Demo\n', 'Первый коммит')
    await commitFile(repo, 'src/app.ts', 'export const a = 1\n', 'Добавить приложение')
    await git(repo, ['switch', '-c', 'feature/login'])
    await commitFile(repo, 'src/login.ts', 'export const login = true\n', 'Форма входа', 'Bob Dev <bob@example.com>')
    await git(repo, ['switch', 'main'])
    await commitFile(repo, 'src/api.ts', 'export const api = 1\n', 'Клиент API')
    await git(repo, ['merge', '--no-ff', '-m', 'Влить вход', 'feature/login'])
    await git(repo, ['tag', '-a', 'v1.0', '-m', 'Релиз'])
    await git(repo, ['remote', 'add', 'origin', bare])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'main', 'feature/login', 'v1.0'])
    await git(repo, ['remote', 'set-head', 'origin', 'main'])
    await commitFile(repo, 'docs/guide.md', 'guide\n', 'Опечтка в документации')
    await commitFile(repo, 'src/cache.ts', 'cache\n', 'Добавить кэш')
    await commitFile(repo, 'src/search.ts', 'search\n', 'Добавить поиск')
    await git(repo, ['push', '-q', 'origin', 'main'])
    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo] }))
    app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: '' } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.recent-row button').first().click()
    await row('Добавить поиск').waitFor()
  })

  afterAll(async () => {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('shows the history graph with refs', async () => {
    expect(await page.locator('.commit-row').count()).toBe(8)
    await expect.poll(() => row('Влить вход').locator('.ref-chip').allTextContents()).toContain('v1.0')
    await expect.poll(() => row('Добавить поиск').locator('.ref-chip').allTextContents()).toContain('main')
    await shot('01-history')
  })

  it('rewords a pushed commit, applies it, and force-pushes after confirmation', async () => {
    await row('Опечтка в документации').click()
    await page.getByLabel('Заголовок').fill('Опечатка в документации')
    await page.getByRole('button', { name: 'Предпросмотр и применение' }).waitFor()
    await shot('02-draft')
    expect(await log()).toContain('Опечтка в документации')
    await page.getByRole('button', { name: 'Предпросмотр и применение' }).click()
    await page.getByRole('button', { name: 'Применить локально' }).waitFor()
    await page.getByText('нужен force-push').waitFor()
    await shot('03-preview')
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).waitFor()
    expect(await log()).toContain('Опечатка в документации')
    expect(await log('origin/main')).toContain('Опечтка в документации')
    await page.getByText('Понимаю').waitFor()
    await shot('04-force-push')
    expect(await page.getByRole('button', { name: 'Перезаписать на сервере' }).isDisabled()).toBe(true)
    await page.getByText('Понимаю').click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).click()
    await expect.poll(async () => (await git(bare, ['log', '--format=%s', 'main'])).split('\n')).toContain('Опечатка в документации')
    expect(await gitLine(bare, ['rev-parse', 'main'])).toBe(await gitLine(repo, ['rev-parse', 'HEAD']))
  })

  it('changes the author through the inspector', async () => {
    await row('Добавить кэш').click()
    await page.getByLabel('Автор', { exact: true }).fill('Лёва')
    await page.getByLabel('Email', { exact: true }).first().fill('leva@example.com')
    await page.getByRole('button', { name: 'Предпросмотр и применение' }).click()
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).waitFor()
    await page.getByRole('button', { name: 'Отмена' }).click()
    await expect.poll(() => gitLine(repo, ['log', '-1', '--format=%an|%ae', 'HEAD~1'])).toBe('Лёва|leva@example.com')
  })

  it('undoes the last rewrite', async () => {
    await page.getByRole('button', { name: 'Отменить', exact: true }).first().click()
    await expect.poll(() => gitLine(repo, ['log', '-1', '--format=%an', 'HEAD~1'])).toBe('Ann Author')
    await expect.poll(() => row('Добавить поиск').count()).toBe(1)
  })

  it('reorders commits by dragging', async () => {
    await row('Добавить поиск').dragTo(row('Опечатка в документации'), { targetPosition: { x: 400, y: 33 } })
    await page.locator('.state-moved').first().waitFor()
    await shot('05-reorder')
    await page.getByRole('button', { name: 'Предпросмотр и применение' }).click()
    await applyAndPublish()
    expect((await log()).slice(0, 3)).toEqual(['Добавить кэш', 'Опечатка в документации', 'Добавить поиск'])
  })

  it('disables melding for the lowest commit of an editable run', async () => {
    await row('Добавить поиск').click({ button: 'right' })
    expect(await page.getByRole('menuitem', { name: 'Объединить с предыдущим' }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
  })

  it('squashes and drops through the context menu', async () => {
    await row('Добавить кэш').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Удалить из истории' }).click()
    await page.locator('.commit-row.dropped').waitFor()
    await row('Опечатка в документации').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Объединить с предыдущим' }).click()
    await page.locator('.commit-row.melded').waitFor()
    await shot('06-squash-drop')
    await page.getByRole('button', { name: 'Предпросмотр и применение' }).click()
    await applyAndPublish()
    expect((await log())[0]).toBe('Добавить поиск')
    expect(await gitLine(repo, ['log', '-1', '--format=%B'])).toBe('Добавить поиск\n\nОпечатка в документации')
  })

  it('renames a branch locally and on the server', async () => {
    await page.locator('.side-item', { hasText: 'feature/login' }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Переименовать…' }).click()
    await page.getByLabel('Новое имя').fill('feature/auth')
    await shot('07-rename')
    await page.getByRole('button', { name: 'Переименовать', exact: true }).click()
    await expect.poll(() => git(bare, ['branch', '--list', '--format=%(refname:short)'])).toContain('feature/auth')
    await expect.poll(() => git(bare, ['branch', '--list', '--format=%(refname:short)'])).not.toContain('feature/login')
    await expect.poll(() => gitLine(repo, ['rev-parse', '--abbrev-ref', 'feature/auth@{upstream}'])).toBe('origin/feature/auth')
  })

  it('commits from the changes view', async () => {
    writeFileSync(join(repo, 'notes.txt'), 'заметка\n')
    await page.locator('.side-nav button', { hasText: 'Изменения' }).click()
    await page.locator('.file-row', { hasText: 'notes.txt' }).waitFor()
    await page.locator('.file-row', { hasText: 'notes.txt' }).click()
    await page.locator('.diff-line.add').first().waitFor()
    await page.locator('.file-row', { hasText: 'notes.txt' }).locator('input').click()
    await page.locator('.file-row', { hasText: 'notes.txt' }).locator('input:checked').waitFor()
    await page.getByLabel('Сообщение коммита').fill('Добавить заметку')
    await shot('08-changes')
    await page.getByRole('button', { name: 'Коммит', exact: true }).click()
    await expect.poll(async () => (await log())[0]).toBe('Добавить заметку')
  })

  it('saves, inspects and clears the stash', async () => {
    writeFileSync(join(repo, 'wip.txt'), 'незаконченное\n')
    await page.locator('.side-nav button', { hasText: 'Stash' }).click()
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await page.getByLabel('Описание').fill('Незаконченная работа')
    await page.getByRole('button', { name: 'Сохранить', exact: true }).last().click()
    await page.locator('.list-card', { hasText: 'Незаконченная работа' }).waitFor()
    await page.locator('.diff-file', { hasText: 'wip.txt' }).waitFor()
    await shot('09-stash')
    await page.getByRole('button', { name: 'Очистить' }).click()
    await page.getByRole('button', { name: /Удалить все/ }).click()
    await page.getByText('Stash пуст').waitFor()
    expect(await git(repo, ['stash', 'list'])).toBe('')
  })

  it('schedules commits for later and publishes them', async () => {
    await page.locator('.side-nav button', { hasText: 'История' }).click()
    await git(repo, ['push', '-q', 'origin', 'main'])
    const tip = await gitLine(repo, ['rev-parse', 'HEAD'])
    await row('Добавить заметку').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /Снять 1 и опубликовать позже/ }).click()
    await shot('10-schedule-dialog')
    await page.getByRole('button', { name: 'Запланировать' }).click()
    await page.locator('.schedule-card').waitFor()
    await shot('11-schedule')
    await expect.poll(() => gitLine(bare, ['log', '-1', '--format=%s', 'main'])).toBe('Добавить поиск')
    await page.getByRole('button', { name: 'Опубликовать сейчас' }).click()
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click()
    await expect.poll(() => gitLine(bare, ['rev-parse', 'main'])).toBe(tip)
    await page.locator('.pill.state-done').waitFor()
  })

  it('removes a file from all history through cleanup', async () => {
    await page.locator('.side-nav button', { hasText: 'История' }).click()
    await page.getByRole('button', { name: 'Очистка истории' }).click()
    await page.getByLabel(/Пути от корня/).fill('src/app.ts')
    await shot('12-cleanup')
    await page.getByRole('button', { name: 'К предпросмотру' }).click()
    await page.getByRole('button', { name: 'Применить локально' }).waitFor()
    await shot('12b-cleanup-preview')
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await page.getByRole('button', { name: 'Перезаписать на сервере' }).waitFor()
    await page.getByRole('button', { name: 'Отмена' }).click()
    await expect.poll(() => git(repo, ['log', '--format=%H', 'main', '--', 'src/app.ts'])).toBe('')
    await page.locator('.side-nav button', { hasText: 'Журнал' }).click()
    await page.getByText(/Удаление из истории/).waitFor()
    await shot('13-journal')
  })

  it('picks up commits made outside the app and renders in the dark theme', async () => {
    await page.locator('.side-nav button', { hasText: 'История' }).click()
    await commitFile(repo, 'outside.txt', 'x\n', 'Коммит из терминала')
    await row('Коммит из терминала').waitFor({ timeout: 10000 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await row('Коммит из терминала').click()
    await page.locator('.diff-line.add').first().waitFor()
    await shot('14-dark')
    expect(pageErrors).toEqual([])
  })
})
