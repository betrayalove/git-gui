import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { addWorktree, lfsInfo, lfsTrack, listSubmodules, listWorktrees, pruneWorktrees, removeWorktree, updateSubmodules } from '../src/core/workspace'
import { commitFile, createRepo, tempDir } from './helpers'

// The native call also expands Windows short names such as RUNNER~1, as git does.
const real = (path: string): string => realpathSync.native(path).replaceAll('\\', '/')

describe('worktrees', () => {
  it('adds, lists and removes checkouts of other branches', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await git(dir, ['branch', 'feature'])
    const place = join(tempDir(), 'feature copy')
    await addWorktree(dir, { path: place, branch: 'feature' })
    const fresh = join(tempDir(), 'fresh')
    await addWorktree(dir, { path: fresh, branch: 'new-work', newBranch: true, from: 'main' })
    // git lists the main checkout first, then the others in its own order.
    const list = await listWorktrees(dir)
    expect(list[0]).toMatchObject({ branch: 'main', main: true, current: true })
    expect(list.slice(1).map((item) => [item.branch, item.main, item.current]).sort()).toEqual([['feature', false, false], ['new-work', false, false]])
    expect(real(list.find((item) => item.branch === 'feature')!.path)).toBe(real(place))
    expect((await listWorktrees(place)).find((item) => item.current)?.branch).toBe('feature')

    writeFileSync(join(place, 'a.txt'), 'changed\n')
    await expect(removeWorktree(dir, place)).rejects.toThrow()
    await removeWorktree(dir, place, true)
    expect(existsSync(place)).toBe(false)
    expect((await listWorktrees(dir)).map((item) => item.branch)).toEqual(['main', 'new-work'])
  })

  it('notices a checkout whose folder was deleted, and forgets it', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const place = join(tempDir(), 'gone')
    await addWorktree(dir, { path: place, branch: 'gone', newBranch: true })
    execFileSync(process.platform === 'win32' ? 'cmd' : 'rm', process.platform === 'win32' ? ['/c', 'rmdir', '/s', '/q', place] : ['-rf', place])
    expect((await listWorktrees(dir)).find((item) => item.branch === 'gone')?.prunable).toBe(true)
    await pruneWorktrees(dir)
    expect((await listWorktrees(dir)).map((item) => item.branch)).toEqual(['main'])
  })

  it('refuses a branch name that would be read as an option', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await expect(addWorktree(dir, { path: join(tempDir(), 'x'), branch: '-f', newBranch: true })).rejects.toThrow('Недопустимое имя')
  })
})

describe('submodules', () => {
  const saved = { ...process.env }
  beforeAll(() => {
    // Since git 2.38.1 submodules from local paths need explicit permission, which only tests use.
    Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' })
  })
  afterAll(() => {
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('lists submodules with their state and downloads missing ones', async () => {
    const library = await createRepo()
    const libSha = await commitFile(library, 'lib.txt', 'lib\n', 'library')
    const app = await createRepo()
    await commitFile(app, 'app.txt', 'app\n', 'app')
    expect(await listSubmodules(app)).toEqual([])
    await git(app, ['submodule', 'add', '-q', library, 'vendor/lib'])
    await git(app, ['commit', '-q', '-m', 'add library'])
    expect(await listSubmodules(app)).toEqual([{ path: 'vendor/lib', sha: libSha, state: 'ok', url: library, describe: expect.any(String) }])

    const clone = tempDir()
    await git(clone, ['clone', '-q', app, '.'])
    expect((await listSubmodules(clone)).map((item) => item.state)).toEqual(['missing'])
    await updateSubmodules(clone)
    expect((await listSubmodules(clone)).map((item) => item.state)).toEqual(['ok'])
    expect(await gitLine(join(clone, 'vendor/lib'), ['log', '-1', '--format=%s'])).toBe('library')

    await commitFile(join(clone, 'vendor/lib'), 'lib.txt', 'newer\n', 'newer library')
    expect((await listSubmodules(clone)).map((item) => item.state)).toEqual(['changed'])
  })
  it('reads a submodule whose path has spaces', async () => {
    const library = await createRepo()
    const libSha = await commitFile(library, 'lib.txt', 'lib\n', 'library')
    const app = await createRepo()
    await commitFile(app, 'app.txt', 'app\n', 'app')
    await git(app, ['submodule', 'add', '-q', library, 'vendor/my lib'])
    await git(app, ['commit', '-q', '-m', 'add library'])
    expect(await listSubmodules(app)).toEqual([{ path: 'vendor/my lib', sha: libSha, state: 'ok', url: library, describe: expect.any(String) }])
    const clone = tempDir()
    await git(clone, ['clone', '-q', app, '.'])
    expect(await listSubmodules(clone)).toEqual([{ path: 'vendor/my lib', sha: libSha, state: 'missing', url: library, describe: null }])
  })
})

const hasLfs = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

it.runIf(process.env.CHRONICLE_REQUIRE_LFS)('has Git LFS to test against', () => {
  expect(hasLfs).toBe(true)
})

describe('Git LFS', () => {
  it('reports a missing installation without failing', async () => {
    const dir = await createRepo()
    writeFileSync(join(dir, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n')
    const info = await lfsInfo(dir)
    expect(info).toMatchObject({ used: true, patterns: ['*.psd'] })
    expect(info.installed).toBe(hasLfs)
  })

  it.runIf(hasLfs)('tracks a pattern and lists stored files', async () => {
    const dir = await createRepo()
    await git(dir, ['lfs', 'install', '--local'])
    expect(await lfsInfo(dir)).toMatchObject({ installed: true, used: false, files: [] })
    await lfsTrack(dir, '*.bin')
    writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2048, 7))
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-q', '-m', 'binary in lfs'])
    const info = await lfsInfo(dir)
    expect(info).toMatchObject({ installed: true, used: true, patterns: ['*.bin'], files: [{ path: 'big.bin', downloaded: true }] })
    await expect(lfsTrack(dir, '--global')).rejects.toThrow('Недопустимая маска')
  })
})
