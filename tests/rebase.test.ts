import { describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { applyRewrite, previewRewrite, rebaseRange, undoEntry } from '../src/core/rewrite'
import type { RewritePlan } from '../src/shared/types'
import { commitFile, createRepo, head, log, tempDir } from './helpers'

async function forkedRepo(): Promise<{ dir: string; base: string }> {
  const dir = await createRepo()
  const base = await commitFile(dir, 'shared.txt', 'one\ntwo\nthree\n', 'base')
  await git(dir, ['switch', '-q', '-c', 'feature'])
  await commitFile(dir, 'feature-a.txt', 'a\n', 'feature a')
  await commitFile(dir, 'feature-b.txt', 'b\n', 'feature b')
  await git(dir, ['switch', '-q', 'main'])
  await commitFile(dir, 'main.txt', 'm\n', 'main moves on')
  return { dir, base }
}

async function movePlan(dir: string, branch: string, onto: string, adjust?: (plan: RewritePlan) => void): Promise<RewritePlan> {
  const range = await rebaseRange(dir, branch, onto)
  const plan: RewritePlan = {
    sequence: { base: range.base, tip: range.tip, onto: range.onto, todo: range.commits.map((commit) => ({ sha: commit.sha, action: 'pick' as const })) }
  }
  adjust?.(plan)
  return plan
}

describe('moving a branch onto another', () => {
  it('describes what would move', async () => {
    const { dir, base } = await forkedRepo()
    const range = await rebaseRange(dir, 'feature', 'main')
    expect(range).toMatchObject({ branch: 'feature', base, upToDate: false, hasMerges: false })
    expect(range.commits.map((commit) => commit.subject)).toEqual(['feature a', 'feature b'])
    expect((await rebaseRange(dir, 'main', 'feature')).commits.map((commit) => commit.subject)).toEqual(['main moves on'])
  })

  it('builds the same trees as git rebase, and touches nothing until applied', async () => {
    const { dir } = await forkedRepo()
    const before = await head(dir, 'feature')
    const preview = await previewRewrite(dir, await movePlan(dir, 'feature', 'main'))
    expect(preview.conflicts).toEqual([])
    expect(await head(dir, 'feature')).toBe(before)
    const update = preview.refUpdates.find((item) => item.name === 'feature')!
    expect(await gitLine(dir, ['rev-parse', `${update.afterCommit}~2`])).toBe(await head(dir, 'main'))

    const reference = (await createRepoCopy(dir))
    await git(reference, ['rebase', '-q', 'main', 'feature'])
    expect(await gitLine(dir, ['rev-parse', `${update.afterCommit}^{tree}`])).toBe(await gitLine(reference, ['rev-parse', 'feature^{tree}']))
  })

  it('applies atomically and undoes exactly', async () => {
    const { dir } = await forkedRepo()
    const before = await head(dir, 'feature')
    const { entry } = await applyRewrite(dir, await movePlan(dir, 'feature', 'main'))
    expect(await log(dir, 'feature')).toEqual(['feature b', 'feature a', 'main moves on', 'base'])
    expect(await log(dir, 'main')).toEqual(['main moves on', 'base'])
    await undoEntry(dir, entry.id)
    expect(await head(dir, 'feature')).toBe(before)
  })

  it('reorders, squashes and drops while moving', async () => {
    const { dir } = await forkedRepo()
    await git(dir, ['switch', '-q', 'feature'])
    await commitFile(dir, 'feature-a.txt', 'a fixed\n', 'fix a')
    await git(dir, ['switch', '-q', 'main'])
    const plan = await movePlan(dir, 'feature', 'main', (draft) => {
      const [a, b, fix] = draft.sequence!.todo
      draft.sequence!.todo = [a, { ...fix, action: 'fixup' }, { ...b, action: 'drop' }]
    })
    await applyRewrite(dir, plan)
    expect(await log(dir, 'feature')).toEqual(['feature a', 'main moves on', 'base'])
    expect(await gitLine(dir, ['show', 'feature:feature-a.txt'])).toBe('a fixed')
    expect(await gitLine(dir, ['ls-tree', '--name-only', 'feature', 'feature-b.txt'])).toBe('')
  })

  it('skips commits whose change the target already has', async () => {
    const { dir } = await forkedRepo()
    const picked = (await rebaseRange(dir, 'feature', 'main')).commits[0].sha
    await git(dir, ['cherry-pick', picked])
    const preview = await previewRewrite(dir, await movePlan(dir, 'feature', 'main'))
    expect(preview.warnings.some((text) => text.includes('уже есть в целевой ветке') && text.endsWith('1'))).toBe(true)
    await applyRewrite(dir, await movePlan(dir, 'feature', 'main'))
    // The copy of feature a on main replaces the original, so the branch keeps only feature b on top.
    expect(await log(dir, 'feature')).toEqual(['feature b', 'feature a', 'main moves on', 'base'])
  })

  it('reports a conflict with both versions, and uses the answer', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'shared.txt', 'one\n', 'base')
    await git(dir, ['switch', '-q', '-c', 'feature'])
    const mine = await commitFile(dir, 'shared.txt', 'feature\n', 'feature edit')
    await git(dir, ['switch', '-q', 'main'])
    await commitFile(dir, 'shared.txt', 'main\n', 'main edit')
    const plan = await movePlan(dir, 'feature', 'main')
    const preview = await previewRewrite(dir, plan)
    expect(preview.conflicts).toMatchObject([{ sha: mine, reason: 'content', files: ['shared.txt'] }])
    expect(preview.refUpdates).toEqual([])
    plan.resolutions = { [mine]: { 'shared.txt': { content: 'both\n' } } }
    await applyRewrite(dir, plan)
    expect(await gitLine(dir, ['show', 'feature:shared.txt'])).toBe('both')
    expect(await log(dir, 'feature')).toEqual(['feature edit', 'main edit', 'base'])
  })

  it('refuses to move a branch onto its own descendant, and sees when nothing needs moving', async () => {
    const { dir } = await forkedRepo()
    await git(dir, ['branch', 'ahead', 'feature'])
    await git(dir, ['switch', '-q', 'ahead'])
    await commitFile(dir, 'more.txt', '1\n', 'more')
    await git(dir, ['switch', '-q', 'main'])
    await expect(previewRewrite(dir, await movePlan(dir, 'feature', 'ahead'))).rejects.toThrow('уже входит')
    expect((await rebaseRange(dir, 'ahead', 'feature')).upToDate).toBe(true)
  })

  it('moves the checked-out branch and its files', async () => {
    const { dir } = await forkedRepo()
    await git(dir, ['switch', '-q', 'feature'])
    await applyRewrite(dir, await movePlan(dir, 'feature', 'main'))
    expect(await gitLine(dir, ['status', '--porcelain'])).toBe('')
    expect(await gitLine(dir, ['show', 'HEAD:main.txt'])).toBe('m')
    expect(await gitLine(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature')
  })
})

async function createRepoCopy(dir: string): Promise<string> {
  const copy = tempDir()
  await git(copy, ['clone', '-q', dir, '.'])
  await git(copy, ['config', 'user.name', 'Test'])
  await git(copy, ['config', 'user.email', 'test@example.com'])
  await git(copy, ['branch', 'feature', 'origin/feature'])
  return copy
}

describe('what a preview reports as new', () => {
  it('lists only commits it wrote, not where a dropped commit went', async () => {
    const { dir } = await forkedRepo()
    const plan = await movePlan(dir, 'feature', 'main', (draft) => { draft.sequence!.todo[0].action = 'drop' })
    const preview = await previewRewrite(dir, plan)
    const main = await head(dir, 'main')
    expect(Object.values(preview.mapping)).toContain(main)
    expect(preview.created).not.toContain(main)
    expect(preview.created).toHaveLength(1)
  })
})
