import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'

const shots = process.env.CHRONICLE_SHOTS
const TOKEN = 'ghp_test_token_for_chronicle'

describe('Pull Requests with a token', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-requests-'))
  const repo = join(root, 'project')
  const bare = join(root, 'server.git')
  const userData = join(root, 'data')
  const created: unknown[] = []
  let api: Server
  let app: ElectronApplication
  let page: Page

  const commit = async (dir: string, path: string, message: string): Promise<void> => {
    writeFileSync(join(dir, path), `${message}\n`)
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-q', '-m', message])
  }

  beforeAll(async () => {
    // A stand-in for the GitHub API that only answers the test token.
    api = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const send = (status: number, body: unknown): void => {
          response.writeHead(status, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify(body))
        }
        if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' })
        if (request.url === '/github/user') return send(200, { login: 'mira' })
        if (request.url === '/github/graphql') {
          return send(200, {
            data: {
              repository: {
                pullRequests: {
                  nodes: [{
                    number: 12, title: 'Add search', url: 'https://github.com/team/project/pull/12', isDraft: false,
                    updatedAt: new Date().toISOString(), headRefName: 'search', baseRefName: 'main', isCrossRepository: false,
                    author: { login: 'alex' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }
                  }]
                }
              }
            }
          })
        }
        if (request.url === '/github/repos/team/project/pulls' && request.method === 'POST') {
          created.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          return send(201, { html_url: 'https://github.com/team/project/pull/13' })
        }
        send(404, { message: 'Not Found' })
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))

    for (const dir of [repo, bare, userData]) mkdirSync(dir)
    await git(bare, ['init', '-q', '--bare', '-b', 'main'])
    await git(repo, ['init', '-q', '-b', 'main'])
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(repo, ['config', key, value])
    await commit(repo, 'readme.md', 'Start')
    // The app reads the server from the stored address, while git really talks to the local copy.
    await git(repo, ['remote', 'add', 'origin', 'https://github.com/team/project.git'])
    await git(repo, ['config', `url.${bare.replaceAll('\\', '/')}.insteadOf`, 'https://github.com/team/project.git'])
    await git(repo, ['push', '-q', '--set-upstream', 'origin', 'main'])
    await git(repo, ['switch', '-q', '-c', 'search'])
    await commit(repo, 'search.md', 'Search from a colleague')
    await git(repo, ['push', '-q', 'origin', 'search'])
    await git(repo, ['switch', '-q', 'main'])
    await git(repo, ['branch', '-q', '-D', 'search'])
    await git(repo, ['switch', '-q', '-c', 'feature'])
    await commit(repo, 'feature.md', 'Add the feature')
    await git(repo, ['switch', '-q', 'main'])

    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo], updateChecks: false, language: 'ru', autoFetchMinutes: 0 }))
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', CHRONICLE_FORGE_API: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
      colorScheme: null
    })
    // Tests must not open the real browser.
    await app.evaluate(({ shell }) => { shell.openExternal = async () => {} })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.recent-row button').first().click()
    await page.locator('.commit-row', { hasText: 'Start' }).waitFor()
  })

  afterAll(async () => {
    await app?.close()
    api?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('asks for a token first, checks it and never keeps it in plain text', async () => {
    await page.keyboard.press('ControlOrMeta+3')
    await page.getByRole('button', { name: 'Добавить токен' }).click()
    const settings = page.getByRole('dialog', { name: 'Настройки' })
    expect(await settings.getByLabel('Токен', { exact: true }).getAttribute('type')).toBe('password')
    await settings.getByLabel('Токен', { exact: true }).fill('wrong')
    await settings.getByRole('button', { name: 'Проверить и сохранить' }).click()
    await settings.getByText('не подошёл или отозван').waitFor()
    await settings.getByLabel('Токен', { exact: true }).fill(TOKEN)
    await settings.getByRole('button', { name: 'Проверить и сохранить' }).click()
    await settings.getByText('Готово: mira на github.com').waitFor()
    if (shots) await page.screenshot({ path: join(shots, '44-token.png') })
    await page.keyboard.press('Escape')
    for (const file of ['forge-tokens.json', 'forge-accounts.json', 'state.json']) {
      const path = join(userData, file)
      if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toContain(TOKEN)
    }
  })

  it('lists open pull requests with their checks and switches to one', async () => {
    const row = page.locator('.request-row', { hasText: 'Add search' })
    await row.waitFor()
    expect(await row.locator('.check-dot').getAttribute('title')).toBe('Проверки упали')
    if (shots) await page.screenshot({ path: join(shots, '45-requests.png') })
    await row.getByRole('button', { name: 'Перейти на ветку' }).click()
    await expect.poll(() => gitLine(repo, ['branch', '--show-current'])).toBe('search')
    expect(await gitLine(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/search')
    await git(repo, ['switch', '-q', 'main'])
  })

  it('pushes a new branch and opens a pull request for it', async () => {
    await page.getByRole('button', { name: 'Создать', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Новый Pull Request' })
    await dialog.getByLabel('Из ветки').selectOption('feature')
    expect(await dialog.getByLabel('Заголовок').inputValue()).toBe('Add the feature')
    expect(await dialog.getByLabel('В ветку').inputValue()).toBe('main')
    await dialog.getByLabel('Описание').fill('Adds the feature.')
    await dialog.getByRole('button', { name: 'Отправить ветку и создать' }).click()
    await page.getByText('Pull Request создан').waitFor()
    expect(await gitLine(bare, ['rev-parse', 'feature'])).toBe(await gitLine(repo, ['rev-parse', 'feature']))
    expect(created).toEqual([{ title: 'Add the feature', head: 'feature', base: 'main', body: 'Adds the feature.', draft: false }])
  })

  it('removes the token only after saying what that means', async () => {
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Настройки' })
    await settings.getByRole('button', { name: 'Удалить токен' }).click()
    await settings.getByText('На сайте он продолжит работать').waitFor()
    await settings.getByRole('button', { name: 'Удалить', exact: true }).click()
    await settings.getByText('mira', { exact: true }).waitFor({ state: 'detached' })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Добавить токен' }).waitFor()
    expect(readFileSync(join(userData, 'forge-accounts.json'), 'utf8')).not.toContain('mira')
  })
})
