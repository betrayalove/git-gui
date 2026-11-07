import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git } from '../src/core/git'
import { blameFile, fileHistory, listFiles } from '../src/core/read'
import { commitFile, createRepo } from './helpers'

describe('file history', () => {
  it('lists the commits that changed a file and follows it through a rename', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'old.txt', 'one\ntwo\nthree\n', 'create')
    await commitFile(dir, 'other.txt', 'x\n', 'unrelated')
    await git(dir, ['mv', 'old.txt', 'new.txt'])
    await git(dir, ['commit', '-q', '-m', 'rename'])
    const renamed = (await git(dir, ['rev-parse', 'HEAD'])).trim()
    const edited = await commitFile(dir, 'new.txt', 'one\ntwo\nthree\nfour\n', 'edit')
    const history = await fileHistory(dir, 'new.txt')
    expect(history.map((version) => version.commit.sha)).toEqual([edited, renamed, first])
    expect(history.map((version) => [version.path, version.status])).toEqual([
      ['new.txt', 'modified'], ['new.txt', 'renamed'], ['old.txt', 'added']
    ])
    expect(history[0].commit.subject).toBe('edit')
  })

  it('lists the files of a commit', async () => {
    const dir = await createRepo()
    expect(await listFiles(dir)).toEqual([])
    await commitFile(dir, 'b/c.txt', '1\n', 'one')
    await commitFile(dir, 'a.txt', '1\n', 'two')
    expect(await listFiles(dir)).toEqual(['a.txt', 'b/c.txt'])
    expect(await listFiles(dir, 'HEAD~1')).toEqual(['b/c.txt'])
  })
})

describe('blame', () => {
  it('names the commit behind each line, at any version', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', 'one\ntwo\nthree\n', 'create')
    const second = await commitFile(dir, 'a.txt', 'one\nTWO\nthree\nfour\n', 'change two, add four')
    const blame = await blameFile(dir, 'a.txt')
    expect(blame.lines.map((line) => [line.line, line.text, line.sha])).toEqual([
      [1, 'one', first], [2, 'TWO', second], [3, 'three', first], [4, 'four', second]
    ])
    expect(blame.commits[second]).toMatchObject({ authorName: 'Ann Author', authorEmail: 'ann@example.com', summary: 'change two, add four' })
    expect(Date.parse(blame.commits[first].authorDate)).toBeGreaterThan(0)
    const older = await blameFile(dir, 'a.txt', first)
    expect(older.lines.map((line) => line.text)).toEqual(['one', 'two', 'three'])
  })

  it('keeps tabs and odd text in lines exactly', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '\tindented\nauthor fake\n\n', 'tricky')
    const blame = await blameFile(dir, 'a.txt')
    expect(blame.lines.map((line) => line.text)).toEqual(['\tindented', 'author fake', ''])
  })

  it('skips binary files instead of showing noise', async () => {
    const dir = await createRepo()
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-q', '-m', 'binary'])
    expect(await blameFile(dir, 'image.bin')).toMatchObject({ lines: [], skipped: 'binary' })
  })
})
