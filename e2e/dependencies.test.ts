import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git } from '../src/core/git'

const shots = process.env.CHRONICLE_SHOTS

/** Stands in for OSV.dev, deps.dev and endoflife.date. */
function fakeDatabases(): Server {
  return createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      const send = (status: number, value: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      const url = request.url ?? ''
      if (url === '/v1/querybatch') {
        const { queries } = JSON.parse(body) as { queries: { package: { name: string } }[] }
        return send(200, { results: queries.map((query) => (query.package.name === 'debug' ? { vulns: [{ id: 'GHSA-gxpj-cx7g-858c', modified: '2024-01-01T00:00:00Z' }] } : {})) })
      }
      if (url.startsWith('/v1/vulns/')) {
        return send(200, {
          id: 'GHSA-gxpj-cx7g-858c', modified: '2024-01-01T00:00:00Z', summary: 'Regular Expression Denial of Service in debug',
          aliases: ['CVE-2017-16137'], database_specific: { severity: 'HIGH' },
          affected: [{ package: { name: 'debug', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.6.9' }] }] }]
        })
      }
      if (url === '/v3/systems/npm/packages/minimist') {
        return send(200, { versions: [{ versionKey: { version: '1.2.0' } }, { versionKey: { version: '1.2.8' }, isDefault: true }] })
      }
      send(404, {})
    })
  })
}

describe('Dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'chronicle-deps-'))
  const repo = join(root, 'project')
  const userData = join(root, 'data')
  const server = fakeDatabases()
  let app: ElectronApplication
  let page: Page

  beforeAll(async () => {
    for (const dir of [repo, userData]) mkdirSync(dir)
    await git(repo, ['init', '-q', '-b', 'main'])
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) await git(repo, ['config', key, value])
    for (const file of ['package.json', 'package-lock.json']) cpSync(join('tests', 'fixtures', 'lockfiles', file), join(repo, file))
    await git(repo, ['add', '--all'])
    await git(repo, ['commit', '-q', '-m', 'Add dependencies'])
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    writeFileSync(join(userData, 'state.json'), JSON.stringify({ recent: [repo], updateChecks: false, language: 'ru' }))
    app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userData}`, '--use-mock-keychain'],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', CHRONICLE_DEPS_SERVER: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
      colorScheme: null
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.locator('.recent-row button').first().click()
    await page.locator('.commit-row', { hasText: 'Add dependencies' }).waitFor()
  })

  afterAll(async () => {
    await app?.close()
    server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('asks before sending anything, then groups advice by urgency', async () => {
    await page.locator('.side-nav button', { hasText: 'Зависимости' }).click()
    await page.getByText('Туда уйдут только имена и версии публичных пакетов', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'Проверить' }).click()

    const urgent = page.locator('.dep-group', { hasText: 'Исправить сейчас' })
    await urgent.locator('.schedule-card', { hasText: 'debug' }).getByText('2.6.8 → 2.6.9').waitFor()
    await urgent.getByText('GHSA-gxpj-cx7g-858c').waitFor()
    await page.locator('.dep-group', { hasText: 'Обновления без риска' }).getByText('1.2.0 → 1.2.8').waitFor()
    await page.getByText('только для разработки', { exact: false }).first().waitFor()
    if (shots) await page.screenshot({ path: join(shots, '50-dependencies.png') })
    expect(JSON.parse(readFileSync(join(userData, 'state.json'), 'utf8'))).toMatchObject({ dependencyConsent: true })
  })
})
