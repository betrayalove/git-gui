import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

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
const app = await electron.launch({
  executablePath: process.argv[2],
  args: [`--user-data-dir=${userData}`],
  env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', SHELL: process.env.SHELL ?? '/bin/zsh' }
})
try {
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.locator('.recent-row button').first().click()
  await page.locator('.commit-row', { hasText: 'Коммит для проверки' }).waitFor({ timeout: 15000 })
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
  const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)
  console.log(JSON.stringify({ ok: errors.length === 0, packaged, csp: Boolean(csp), errors }))
  if (errors.length) process.exitCode = 1
} finally {
  await app.close()
  rmSync(root, { recursive: true, force: true })
}
