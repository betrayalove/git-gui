import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// Renders build/icon.svg to the PNG the installers are built from. Run `pnpm icon` after changing the SVG.
const root = join(import.meta.dirname, '..')
const app = await electron.launch({ args: [join(root, 'out/main/index.js'), `--user-data-dir=${join(root, 'out/icon-user-data')}`] })
const page = await app.firstWindow()
await page.setViewportSize({ width: 1024, height: 1024 })
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8')
await page.evaluate((markup) => {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.innerHTML = markup
  document.body.style.margin = '0'
}, svg)
await page.locator('svg').first().screenshot({ path: join(root, 'build/icon.png'), omitBackground: true })
await app.close()
