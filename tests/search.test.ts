import { describe, expect, it } from 'vitest'
import { git } from '../src/core/git'
import { searchChanges } from '../src/core/read'
import { commitFile, createRepo } from './helpers'

describe('searching changed lines', () => {
  it('finds commits that added or removed the text, and none that merely kept it', async () => {
    const dir = await createRepo()
    const added = await commitFile(dir, 'a.txt', 'const apiKey = load()\n', 'add key loading')
    await commitFile(dir, 'a.txt', 'const apiKey = load()\nother\n', 'unrelated line')
    const removed = await commitFile(dir, 'a.txt', 'other\n', 'drop key loading')
    expect((await searchChanges(dir, { text: 'apikey' })).shas).toEqual([removed, added])
  })

  it('treats the text literally, not as a pattern', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', 'axb\n', 'similar text')
    const exact = await commitFile(dir, 'b.txt', 'a.b (x)\n', 'exact text')
    expect((await searchChanges(dir, { text: 'a.b (x)' })).shas).toEqual([exact])
  })

  it('searches every branch and can narrow to a path', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'base')
    await git(dir, ['switch', '-q', '-c', 'side'])
    const side = await commitFile(dir, 'docs/x.md', 'needle\n', 'on a side branch')
    await git(dir, ['switch', '-q', 'main'])
    const main = await commitFile(dir, 'src/y.ts', 'needle\n', 'on main')
    expect(new Set((await searchChanges(dir, { text: 'needle' })).shas)).toEqual(new Set([side, main]))
    expect((await searchChanges(dir, { text: 'needle', path: 'docs' })).shas).toEqual([side])
  })

  it('says when there are more results than it returns', async () => {
    const dir = await createRepo()
    for (let index = 0; index < 3; index++) await commitFile(dir, 'a.txt', `match ${index}\n`, `commit ${index}`)
    expect(await searchChanges(dir, { text: 'match', limit: 2 })).toMatchObject({ limited: true })
    expect((await searchChanges(dir, { text: 'match', limit: 2 })).shas).toHaveLength(2)
  })

  it('returns nothing for an empty query or an empty repository', async () => {
    const dir = await createRepo()
    expect(await searchChanges(dir, { text: 'x' })).toEqual({ shas: [], limited: false })
    await commitFile(dir, 'a.txt', 'x\n', 'one')
    expect(await searchChanges(dir, { text: '   ' })).toEqual({ shas: [], limited: false })
  })
})
