import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { checkForUpdate, isNewerVersion } from '../src/core/updates'

describe('version comparison', () => {
  it.each([
    ['0.3.0', '0.2.0', true],
    ['v0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.2.0', '0.2.0', false],
    ['0.2.0', '0.3.0', false],
    ['0.2', '0.2.0', false],
    ['1.0.0', '1.0.0-beta.1', true],
    ['1.0.0-beta.1', '1.0.0', false]
  ])('%s against %s', (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected)
  })
})

describe('checking for an update', () => {
  let server: Server | null = null
  afterEach(() => { server?.close(); server = null })

  async function serve(status: number, body: unknown): Promise<string> {
    server = createServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`
  }

  it('reports a newer release', async () => {
    const url = await serve(200, { tag_name: 'v0.5.0', html_url: 'https://github.com/x/y/releases/v0.5.0' })
    expect(await checkForUpdate('0.3.0', url)).toEqual({ current: '0.3.0', latest: '0.5.0', available: true, url: 'https://github.com/x/y/releases/v0.5.0' })
  })

  it('treats no releases as no update', async () => {
    expect(await checkForUpdate('0.3.0', await serve(404, {}))).toMatchObject({ latest: null, available: false })
  })

  it('ignores a release page that is not HTTPS', async () => {
    const url = await serve(200, { tag_name: 'v9.0.0', html_url: 'http://evil.example/' })
    expect(await checkForUpdate('0.3.0', url)).toMatchObject({ available: false, url: null })
  })

  it('reports a server error', async () => {
    await expect(checkForUpdate('0.3.0', await serve(500, {}))).rejects.toThrow('500')
  })
})
