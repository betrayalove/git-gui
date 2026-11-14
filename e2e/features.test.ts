import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'

const shots = process.env.CHRONICLE_SHOTS

describe('History tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-features-'))
  const repo = join(root, 'project')
  const bare = join(root, 'server.git')
  const other = join(root, 'colleague')
  const userData = join(root, 'data')
  const worktreeParent = join(root, 'worktrees')
  let app: ElectronApplication
  let page: Page

  const commit = async (dir: string, path: string, content: string, message: string): Promise<void> => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-q', '-m', message])
  }
  const log = async (rev = 'HEAD'): Promise<string[]> => (await git(repo, ['log', '--format=%s', rev])).split('\n').filter(Boolean)
  const row = (subject: string) => page.locator('.commit-row', { hasText: subject })
  const shot = async (name: string): Promise<void> => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
  }
  const settled = async (): Promise<void> => {
    await page.waitForTimeout(50)
    await page.locator('.busy').waitFor({ state: 'detached' })
  }
  const branchMenu = async (name: string, item: string): Promise<void> => {
    await page.locator('.side-item', { hasText: new RegExp(`^${name}`) }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: item }).click()
  }

  beforeAll(async () => {
    for (const dir of [repo, bare, userData, worktreeParent]) mkdirSync(dir)
    await git(bare, ['init', '-q', '--bare', '-b', 'main'])
    await git(repo, ['init', '-q', '-b', 'main'])
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(repo, ['config', key, value])
    await commit(repo, 'src/config.ts', 'export const port = 80\nexport const host = "localhost"\n', 'Add configuration')
    await commit(repo, 'shared.txt', 'base\n', 'Add shared file')
    await git(repo, ['mv', 'src/config.ts', 'src/settings.ts'])
    await git(repo, ['commit', '-q', '-m', 'Rename configuration'])
    await commit(repo, 'src/settings.ts', 'export const port = 8080\nexport const host = "localhost"\n', 'Use port 8080')
    await git(repo, ['remote', 'add', 'origin', bare])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'main'])

    await git(repo, ['switch', '-q', '-c', 'feature'])
    await commit(repo, 'feature/one.txt', '1\n', 'Feature step one')
    await commit(repo, 'feature/two.txt', '2\n', 'Feature step two')
    await git(repo, ['switch', '-q', '-c', 'clash', 'main'])
    await commit(repo, 'shared.txt', 'clash\n', 'Change shared file differently')
    await git(repo, ['switch', '-q', 'main'])
    await commit(repo, 'shared.txt', 'main\n', 'Change shared file on main')

    // A colleague pushes to main meanwhile, so pull has two diverged sides to join.
    await git(root, ['clone', '-q', bare, other])
    for (const [key, value] of [['user.name', 'Colleague'], ['user.email', 'c@example.com']]) await git(other, ['config', key, value])
    await commit(other, 'docs/guide.md', 'guide\n', 'Colleague writes a guide')
    await git(other, ['push', '-q', 'origin', 'main'])

    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo], updateChecks: false, language: 'ru' }))
    // Without colorScheme: null, Playwright pretends the system is light and the app's theme setting is never seen.
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      colorScheme: null
    })
    // The folder picker is a system window that tests cannot click.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
    }, worktreeParent)
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.recent-row button').first().click()
    await row('Change shared file on main').waitFor()
  })

  afterAll(async () => {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('finds commits by the lines they changed and marks the text', async () => {
    await page.getByRole('button', { name: '{ }' }).click()
    await page.getByLabel('Поиск в изменениях').fill('8080')
    await expect.poll(() => page.locator('.commit-row').allInnerTexts()).toHaveLength(1)
    await row('Use port 8080').click()
    await page.locator('.diff-line mark', { hasText: '8080' }).first().waitFor()
    await shot('40-search-changes')
    await page.getByLabel('Поиск в изменениях').fill('')
    await page.getByRole('button', { name: '{ }' }).click()
  })

  it('shows a file history through a rename, and who changed each line', async () => {
    await page.locator('.side-nav button', { hasText: 'Файлы' }).click()
    await page.getByLabel('Найти файл').fill('settings')
    await page.locator('.file-pick', { hasText: 'settings.ts' }).click()
    await page.locator('.file-version', { hasText: 'Add configuration' }).waitFor()
    await page.locator('.file-version', { hasText: 'Rename configuration' }).waitFor()
    await shot('41-file-history')
    await page.getByRole('tab', { name: 'Кто менял строки' }).click()
    await page.locator('.blame-commit', { hasText: 'Use port 8080' }).waitFor()
    await page.locator('.blame-commit', { hasText: 'Add configuration' }).waitFor()
    await shot('42-blame')
    await page.locator('.blame-commit', { hasText: 'Use port 8080' }).click()
    await page.locator('.commit-row.selected', { hasText: 'Use port 8080' }).waitFor()
  })

  it('predicts a merge conflict and leaves it for the editor', async () => {
    await branchMenu('clash', 'Влить в main')
    await page.getByText('Будут конфликты').waitFor()
    await page.getByText('shared.txt').first().waitFor()
    await shot('43-merge-preview')
    await page.getByRole('button', { name: 'Влить', exact: true }).click()
    await page.locator('.side-nav button.active', { hasText: 'Изменения' }).waitFor()
    await page.getByText('Идёт операция merge').waitFor()
    await page.getByRole('button', { name: 'Отменить операцию' }).click()
    await settled()
    expect(await gitLine(repo, ['status', '--porcelain'])).toBe('')
    await page.locator('.side-nav button', { hasText: 'История' }).click()
  })

  it('moves a branch onto another, editing it and seeing the result first', async () => {
    await branchMenu('feature', 'Перенести на другую ветку…')
    await page.getByText('Как будет выглядеть ветка').waitFor()
    await page.locator('.result-history li.new', { hasText: 'Feature step two' }).waitFor()
    await page.getByLabel('Что сделать с «Feature step one»').selectOption('drop')
    await expect.poll(() => page.locator('.result-history li.new').allInnerTexts()).toHaveLength(1)
    await shot('44-move-branch')
    await page.getByRole('button', { name: 'Дальше' }).click()
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await settled()
    expect(await log('feature')).toEqual(['Feature step two', 'Change shared file on main', 'Use port 8080', 'Rename configuration', 'Add shared file', 'Add configuration'])
  })

  it('pulls with rebase through a preview when both sides moved', async () => {
    await page.getByRole('button', { name: 'Pull' }).click()
    await page.getByText('И на сервере, и у тебя есть новые коммиты').waitFor()
    await page.getByText('Конфликтов не будет.').waitFor()
    await shot('45-pull')
    await page.getByRole('button', { name: 'Дальше' }).click()
    await page.getByRole('button', { name: 'Применить локально' }).click()
    await settled()
    expect((await log()).slice(0, 2)).toEqual(['Change shared file on main', 'Colleague writes a guide'])
    expect(await gitLine(repo, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('0')
  })

  it('opens a branch in its own folder and switches to it', async () => {
    await page.getByRole('button', { name: 'Ветка в отдельной папке' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Новая ветка' }).click()
    await page.getByLabel(/Имя новой ветки/).fill('hotfix')
    await page.getByRole('button', { name: 'Выбрать папку' }).click()
    await page.getByText('Будет создана папка').waitFor()
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    await page.locator('.side-section', { hasText: 'Рабочие копии' }).locator('.side-item', { hasText: 'hotfix' }).waitFor()
    await shot('46-worktrees')
    await page.locator('.side-section', { hasText: 'Рабочие копии' }).locator('.side-item', { hasText: 'hotfix' }).click()
    await page.locator('.repo-switch', { hasText: 'project-hotfix' }).waitFor()
    await page.locator('.branch-name', { hasText: 'hotfix' }).waitFor()
  })

  it('switches the theme and the language, keeping the open repository', async () => {
    const prefersLight = (): Promise<boolean> => page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)
    await page.getByRole('button', { name: 'Настройки' }).click()
    await page.getByRole('button', { name: 'Светлая' }).click()
    await expect.poll(prefersLight).toBe(true)
    await page.getByRole('button', { name: 'Тёмная' }).click()
    await expect.poll(prefersLight).toBe(false)

    await page.getByRole('button', { name: 'English' }).click()
    await page.locator('.side-nav button', { hasText: 'History' }).waitFor()
    await page.locator('.repo-switch', { hasText: 'project-hotfix' }).waitFor()
    // Returns the Russian text left on screen with a little context, so a failure names it.
    const russianLeft = (): Promise<string | null> => page.evaluate(() => {
      const text = document.body.innerText.replace('Русский', '')
      const at = text.search(/[А-Яа-яЁё]/)
      return at === -1 ? null : text.slice(Math.max(0, at - 30), at + 40)
    })
    for (const view of ['History', 'Changes', 'Files', 'Stash', 'Publishing', 'Dependencies', 'Journal']) {
      await page.locator('.side-nav button', { hasText: view }).click()
      await expect.poll(russianLeft).toBeNull()
    }
    await page.locator('.side-nav button', { hasText: 'History' }).click()
    await page.getByRole('button', { name: 'Settings' }).click()
    await expect.poll(russianLeft).toBeNull()
    expect(JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))).toMatchObject({ language: 'en', theme: 'dark' })

    await page.getByRole('button', { name: 'Русский' }).click()
    await page.locator('.side-nav button', { hasText: 'История' }).waitFor()
  })
})

describe('Tabs and background fetch', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-tabs-'))
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  const bare = join(root, 'server.git')
  const other = join(root, 'colleague')
  const userData = join(root, 'data')
  let app: ElectronApplication
  let page: Page

  const setUp = async (dir: string): Promise<void> => {
    await git(dir, ['init', '-q', '-b', 'main'])
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(dir, ['config', key, value])
    writeFileSync(join(dir, 'readme.txt'), `${dir}\n`)
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-q', '-m', 'Start'])
  }
  const tab = (name: string) => page.getByRole('tab', { name })

  beforeAll(async () => {
    for (const dir of [alpha, beta, bare, userData]) mkdirSync(dir)
    await setUp(alpha)
    await setUp(beta)
    await git(bare, ['init', '-q', '--bare', '-b', 'main'])
    await git(alpha, ['remote', 'add', 'origin', bare])
    await git(alpha, ['push', '-q', '--set-upstream', 'origin', 'main'])
    // A colleague pushes before the app starts, so only a fetch can reveal the new commit.
    await git(root, ['clone', '-q', bare, other])
    for (const [key, value] of [['user.name', 'Colleague'], ['user.email', 'c@example.com']]) await git(other, ['config', key, value])
    writeFileSync(join(other, 'news.txt'), 'news\n')
    await git(other, ['add', '--all'])
    await git(other, ['commit', '-q', '-m', 'Colleague adds news'])
    await git(other, ['push', '-q', 'origin', 'main'])

    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [alpha, beta], updateChecks: false, language: 'ru', autoFetchMinutes: 5 }))
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      colorScheme: null
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  afterAll(async () => {
    await app?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('fetches by itself after opening, so Pull shows the new commit', async () => {
    await page.locator('.recent-row b', { hasText: /^alpha$/ }).click()
    await page.getByRole('button', { name: /Pull/ }).locator('.count', { hasText: '1' }).waitFor()
    expect(await page.getByRole('button', { name: /Fetch/ }).getAttribute('title')).toMatch(/^Последний fetch: /)
  })

  it('keeps each repository in its own tab with its own state', async () => {
    await page.locator('.side-nav button', { hasText: 'Изменения' }).click()
    await page.getByRole('button', { name: 'Новая вкладка' }).click()
    await page.locator('.recent-row b', { hasText: /^beta$/ }).click()
    await expect.poll(() => page.getByRole('tab').allInnerTexts()).toEqual(['alpha', 'beta'])
    await page.locator('.commit-row', { hasText: 'Start' }).waitFor()
    await shot('tabs')

    await tab('alpha').click()
    await page.locator('.side-nav button.active', { hasText: 'Изменения' }).waitFor()
    await page.keyboard.press('Control+Tab')
    await expect.poll(() => tab('beta').getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('Control+Shift+Tab')
    await expect.poll(() => tab('alpha').getAttribute('aria-selected')).toBe('true')

    // Opening a repository that already has a tab goes to that tab. The recent list may now hold
    // beta twice, as the test wrote its path (/var, C:\Users\RUNNER~1) and as git spells it,
    // and both lead to the same repository.
    await page.keyboard.press('ControlOrMeta+t')
    await page.locator('.recent-row b', { hasText: /^beta$/ }).first().click()
    await expect.poll(() => page.getByRole('tab').allInnerTexts()).toEqual(['alpha', 'beta'])
    expect(await tab('beta').getAttribute('aria-selected')).toBe('true')

    await page.getByRole('button', { name: 'Закрыть вкладку beta' }).click()
    await expect.poll(() => page.getByRole('tab').allInnerTexts()).toEqual(['alpha'])
    await page.locator('.side-nav button.active', { hasText: 'Изменения' }).waitFor()
  })

  async function shot(name: string): Promise<void> {
    if (shots) await page.screenshot({ path: join(shots, `43-${name}.png`) })
  }
})
