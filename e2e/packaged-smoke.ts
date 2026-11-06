import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { startGitHttpServer } from '../tests/git-http-server.ts'

// Launches the installed build the way Finder would, with a minimal PATH:
// node --experimental-strip-types e2e/packaged-smoke.ts dist/mac-arm64/Chronicle.app/Contents/MacOS/Chronicle
const root = mkdtempSync(join(tmpdir(), 'chronicle-smoke-'))
const repo = join(root, 'repo')
const userData = join(root, 'data')
mkdirSync(repo)
mkdirSync(userData)
const git = (...args: string[]): void => void execFileSync('git', args, { cwd: repo })
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Test')
git('config', 'user.email', 'test@example.com')
writeFileSync(join(repo, 'a.txt'), 'a\n')
git('add', '.')
git('commit', '-q', '-m', 'Коммит для проверки')
writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo] }))
// The dialog for passwords relies on helper files the app writes and starts through git, which only
// a packaged build can prove works.
const bare = join(root, 'server.git')
mkdirSync(bare)
execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare })
const http = await startGitHttpServer(bare, 'smoke', 'smoke-password')
git('remote', 'add', 'origin', http.url)
const gitConfig = join(root, 'gitconfig')
writeFileSync(gitConfig, '')
const noKeychain = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig }
const app = await electron.launch({
  executablePath: process.argv[2],
  args: [`--user-data-dir=${userData}`],
  // Finder hands apps a minimal PATH. Windows apps inherit the normal environment.
  env: process.platform === 'darwin'
    ? { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', SHELL: process.env.SHELL ?? '/bin/zsh', ...noKeychain }
    : { ...process.env, ...noKeychain } as Record<string, string>
})
try {
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.locator('.recent-row button').first().click()
  await page.locator('.commit-row', { hasText: 'Коммит для проверки' }).waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Push' }).click()
  const login = page.getByRole('dialog', { name: 'Вход на сервер' })
  const preview = page.getByText('новая ветка на сервере')
  // Each check of the server asks again, because this test keeps no login between them.
  for (const started = Date.now(); !(await preview.isVisible());) {
    if (Date.now() - started > 60000) throw new Error('The password dialog did not reach git')
    if (await login.isVisible()) {
      const username = login.getByLabel('Имя пользователя')
      if (await username.isVisible()) await username.fill('smoke')
      else await login.getByLabel('Пароль или токен').fill('smoke-password')
      await login.getByRole('button', { name: 'Продолжить' }).click()
    }
    await page.waitForTimeout(100)
  }
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)
  console.log(JSON.stringify({ ok: errors.length === 0, packaged, csp: Boolean(csp), errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await app.close()
  http.server.close()
  rmSync(root, { recursive: true, force: true })
}
