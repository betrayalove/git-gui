import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'

/** A tiny git server over HTTP with a password. It answers enough for `git ls-remote`. */
export function startGitHttpServer(bare: string, username: string, password: string): Promise<{ server: Server; url: string; attempts: () => number }> {
  let attempts = 0
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  const server = createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      if (request.headers.authorization) attempts++
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      response.end()
      return
    }
    const refs = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare])
    const head = '# service=git-upload-pack\n'
    const line = `${(head.length + 4).toString(16).padStart(4, '0')}${head}0000`
    response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Cache-Control': 'no-cache' })
    response.end(Buffer.concat([Buffer.from(line), refs]))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${port}/team/project.git`, attempts: () => attempts })
    })
  })
}
