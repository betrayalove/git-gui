import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

interface Published {
  version: string
  dependencies: Record<string, string>
  tarball: Buffer
}

/** One file of a tar archive in the ustar format that npm and pnpm unpack. */
function tarEntry(path: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  const field = (offset: number, length: number, value: string): void => {
    header.write(value, offset, length, 'utf8')
  }
  field(0, 100, path)
  field(100, 8, '0000644\0')
  field(108, 8, '0000000\0')
  field(116, 8, '0000000\0')
  field(124, 12, `${content.length.toString(8).padStart(11, '0')}\0`)
  field(136, 12, '00000000000\0')
  field(148, 8, '        ')
  field(156, 1, '0')
  field(257, 6, 'ustar\0')
  field(263, 2, '00')
  let sum = 0
  for (const byte of header) sum += byte
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return Buffer.concat([header, content, padding])
}

function packageTarball(name: string, version: string, dependencies: Record<string, string>): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version, dependencies }, null, 2))
  return gzipSync(Buffer.concat([tarEntry('package/package.json', manifest), Buffer.alloc(1024)]))
}

/**
 * A registry that answers the npm protocol from memory, so package managers run without the network.
 * Point them at it with `npm_config_registry`.
 */
export class FakeNpmRegistry {
  private readonly packages = new Map<string, Published[]>()
  private server: Server | null = null
  url = ''
  /** Package names asked for, so a test can see what a package manager looked up. */
  readonly requests: string[] = []

  /**
   * With public tarball addresses lockfiles look like real ones, which the lockfile parser
   * requires. npm fetches such addresses from the configured registry, and lockfile-only installs
   * fetch nothing; Yarn does fetch, and from the address as given.
   */
  constructor(private readonly options: { publicTarballs: boolean } = { publicTarballs: true }) {}

  publish(name: string, version: string, dependencies: Record<string, string> = {}): this {
    const list = this.packages.get(name) ?? []
    list.push({ version, dependencies, tarball: packageTarball(name, version, dependencies) })
    this.packages.set(name, list)
    return this
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\//, '')
      const tarball = /^(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/.exec(path)
      if (tarball) {
        const found = this.packages.get(tarball[1])?.find((item) => item.version === tarball[2])
        if (!found) return void response.writeHead(404).end()
        response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(found.tarball)
        return
      }
      this.requests.push(path)
      const list = this.packages.get(path)
      if (!list) {
        response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found"}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.packument(path, list)))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`
    return this.url
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  }

  private packument(name: string, list: Published[]): object {
    const file = name.slice(name.lastIndexOf('/') + 1)
    const versions = Object.fromEntries(list.map((item) => [item.version, {
      name,
      version: item.version,
      dependencies: item.dependencies,
      dist: {
        tarball: `${this.options.publicTarballs ? 'https://registry.npmjs.org/' : this.url}${name}/-/${file}-${item.version}.tgz`,
        shasum: createHash('sha1').update(item.tarball).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(item.tarball).digest('base64')}`
      }
    }]))
    const time = Object.fromEntries(list.map((item, index) => [item.version, new Date(Date.UTC(2024, 0, 1 + index)).toISOString()]))
    return { name, 'dist-tags': { latest: list[list.length - 1].version }, versions, time }
  }
}
