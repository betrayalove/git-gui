import { describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { mergeBranch, mergePreview, readWorktreeConflicts } from '../src/core/ops'
import { readStatus } from '../src/core/read'
import { commitFile, createRepo, head, log } from './helpers'

async function diverged(conflicting: boolean): Promise<string> {
  const dir = await createRepo()
  await commitFile(dir, 'shared.txt', 'base\n', 'base')
  await git(dir, ['switch', '-q', '-c', 'feature'])
  await commitFile(dir, conflicting ? 'shared.txt' : 'feature.txt', 'feature\n', 'feature work')
  await git(dir, ['switch', '-q', 'main'])
  await commitFile(dir, conflicting ? 'shared.txt' : 'main.txt', 'main\n', 'main work')
  return dir
}

describe('merge preview', () => {
  it('predicts conflicts without changing anything', async () => {
    const dir = await diverged(true)
    const before = await head(dir)
    const preview = await mergePreview(dir, 'feature')
    expect(preview).toMatchObject({ upToDate: false, fastForward: false, incomingCount: 1, localCount: 1, conflicts: ['shared.txt'] })
    expect(preview.incoming.map((commit) => commit.subject)).toEqual(['feature work'])
    expect(await head(dir)).toBe(before)
    expect((await readStatus(dir)).files).toEqual([])
  })

  it('sees a clean merge, a fast-forward and nothing to do', async () => {
    const clean = await diverged(false)
    expect(await mergePreview(clean, 'feature')).toMatchObject({ fastForward: false, conflicts: [] })
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await git(dir, ['branch', 'old'])
    await commitFile(dir, 'a.txt', '2\n', 'two')
    expect(await mergePreview(dir, 'old')).toMatchObject({ upToDate: true, incomingCount: 0, localCount: 1 })
    await git(dir, ['switch', '-q', 'old'])
    expect(await mergePreview(dir, 'main')).toMatchObject({ fastForward: true, incomingCount: 1, conflicts: [] })
  })
})

describe('merging', () => {
  it('can force a merge commit or squash everything into the index', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await git(dir, ['switch', '-q', '-c', 'feature'])
    await commitFile(dir, 'b.txt', '2\n', 'two')
    await git(dir, ['switch', '-q', 'main'])
    await mergeBranch(dir, 'feature', 'no-ff')
    expect((await gitLine(dir, ['log', '-1', '--format=%P'])).split(' ')).toHaveLength(2)
    await git(dir, ['reset', '-q', '--hard', 'HEAD~1'])
    await mergeBranch(dir, 'feature', 'squash')
    expect(await log(dir)).toEqual(['one'])
    expect((await readStatus(dir)).files.map((file) => [file.path, file.staged])).toEqual([['b.txt', 'added']])
  })

  it('leaves conflicts in place for the editor', async () => {
    const dir = await diverged(true)
    await expect(mergeBranch(dir, 'feature')).rejects.toThrow(/CONFLICT|Automatic merge failed/)
    expect((await readStatus(dir)).operation).toBe('merge')
    expect((await readWorktreeConflicts(dir)).map((conflict) => conflict.path)).toEqual(['shared.txt'])
  })
})
