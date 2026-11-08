import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { commitDiff } from '../src/core/read'
import { buildPatch } from '../src/shared/patch'
import type { FileDiff, RewritePlan } from '../src/shared/types'
import { applyRewrite, moveRefs, previewRewrite, purgeBackups, readJournal, redoEntry, signingSetup, undoEntry } from '../src/core/rewrite'
import { addOrigin, commitFile, createRepo, head, log, mergeNoFf, resetClock, tempDir, write } from './helpers'

beforeEach(resetClock)

async function linearRepo(): Promise<{ dir: string; shas: string[] }> {
  const dir = await createRepo()
  const shas = [
    await commitFile(dir, 'a.txt', '1\n', 'first'),
    await commitFile(dir, 'b.txt', '2\n', 'second'),
    await commitFile(dir, 'c.txt', '3\n', 'third'),
    await commitFile(dir, 'd.txt', '4\n', 'fourth')
  ]
  return { dir, shas }
}

describe('metadata edits', () => {
  it('rewords a commit and keeps every other byte of history', async () => {
    const { dir, shas } = await linearRepo()
    const before = await log(dir, 'HEAD', '%T|%an|%ae|%aI|%cn|%ce|%cI')
    await applyRewrite(dir, { edits: { [shas[1]]: { message: 'Second, reworded\n\nWith a body' } } })
    expect(await log(dir)).toEqual(['fourth', 'third', 'Second, reworded', 'first'])
    expect(await log(dir, 'HEAD', '%T|%an|%ae|%aI|%cn|%ce|%cI')).toEqual(before)
    expect(await gitLine(dir, ['log', '--format=%b', '-1', 'HEAD~2'])).toBe('With a body')
  })

  it('applies nothing when branches moved after the preview was shown', async () => {
    const { dir, shas } = await linearRepo()
    const plan: RewritePlan = { edits: { [shas[1]]: { message: 'changed' } } }
    const preview = await previewRewrite(dir, plan)
    const moved = await commitFile(dir, 'late.txt', 'late\n', 'late')
    await expect(applyRewrite(dir, plan, preview.refUpdates)).rejects.toThrow('Ветки изменились после предпросмотра')
    expect(await head(dir)).toBe(moved)
    expect(await log(dir)).toContain('second')
    const fresh = await previewRewrite(dir, plan)
    await applyRewrite(dir, plan, fresh.refUpdates)
    expect(await log(dir)).toContain('changed')
  })

  it('leaves commits older than the edit on their original SHA', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, { edits: { [shas[2]]: { message: 'changed' } } })
    expect(await head(dir, 'HEAD~3')).toBe(shas[0])
    expect(await head(dir, 'HEAD~2')).toBe(shas[1])
    expect(await head(dir, 'HEAD~1')).not.toBe(shas[2])
  })

  it('changes author, committer and dates, keeping the timezone it was given', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, {
      edits: {
        [shas[1]]: {
          authorName: 'Лёва Новый',
          authorEmail: 'new@example.com',
          authorDate: '2020-01-02T03:04:05+05:00',
          committerName: 'Other',
          committerEmail: 'other@example.com',
          committerDate: '2021-06-07T08:09:10-02:30'
        }
      }
    })
    const line = await gitLine(dir, ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%cI', 'HEAD~2'])
    expect(line).toBe('Лёва Новый|new@example.com|2020-01-02T03:04:05+05:00|Other|other@example.com|2021-06-07T08:09:10-02:30')
    expect(await gitLine(dir, ['log', '-1', '--format=%an', 'HEAD~1'])).toBe('Ann Author')
  })

  it('edits the root commit', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, { edits: { [shas[0]]: { message: 'root renamed' } } })
    expect(await log(dir)).toEqual(['fourth', 'third', 'second', 'root renamed'])
  })

  it('rejects identity values that would corrupt the commit object', async () => {
    const { dir, shas } = await linearRepo()
    await expect(previewRewrite(dir, { edits: { [shas[1]]: { authorName: 'Evil <x>\nparent 00' } } })).rejects.toThrow('недопустимые')
    await expect(previewRewrite(dir, { edits: { [shas[1]]: { message: '   ' } } })).rejects.toThrow('пустым')
  })

  it('keeps merge commits and the shape of the graph', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    await git(dir, ['switch', '-c', 'feature'])
    await commitFile(dir, 'f.txt', 'f\n', 'feature work')
    await git(dir, ['switch', 'main'])
    await commitFile(dir, 'm.txt', 'm\n', 'main work')
    await mergeNoFf(dir, 'feature', 'merge feature')
    await commitFile(dir, 'z.txt', 'z\n', 'after merge')
    const parentCounts = (raw: string): number[] => raw.trimEnd().split('\n').map((line) => (line ? line.split(' ').length : 0))
    const shapeBefore = parentCounts(await git(dir, ['log', '--format=%p']))
    const treesBefore = await log(dir, 'HEAD', '%T')
    await applyRewrite(dir, { edits: { [first]: { message: 'first renamed' } } })
    expect(parentCounts(await git(dir, ['log', '--format=%p']))).toEqual(shapeBefore)
    expect(await log(dir, 'HEAD', '%T')).toEqual(treesBefore)
    expect(await gitLine(dir, ['log', '--merges', '--format=%s'])).toBe('merge feature')
    expect(await gitLine(dir, ['log', '-1', '--format=%s', 'feature'])).toBe('feature work')
    expect((await git(dir, ['merge-base', '--is-ancestor', 'feature', 'main']))).toBe('')
  })

  it('moves other branches and tags, and rebuilds annotated tags', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['branch', 'side', shas[2]])
    await git(dir, ['tag', 'light', shas[2]])
    await git(dir, ['tag', '-a', 'annotated', '-m', 'release notes', shas[2]])
    await applyRewrite(dir, { edits: { [shas[1]]: { message: 'changed' } } })
    const third = await head(dir, 'HEAD~1')
    expect(third).not.toBe(shas[2])
    expect(await head(dir, 'side')).toBe(third)
    expect(await head(dir, 'light')).toBe(third)
    expect(await head(dir, 'annotated^{commit}')).toBe(third)
    expect(await gitLine(dir, ['cat-file', '-t', 'annotated'])).toBe('tag')
    expect(await gitLine(dir, ['tag', '-l', '--format=%(contents:subject)', 'annotated'])).toBe('release notes')
  })

  it('keeps staged and unstaged work when the tree does not change', async () => {
    const { dir, shas } = await linearRepo()
    write(dir, 'a.txt', 'dirty\n')
    write(dir, 'staged.txt', 'staged\n')
    await git(dir, ['add', 'staged.txt'])
    await applyRewrite(dir, { edits: { [shas[3]]: { message: 'renamed tip' } } })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('dirty\n')
    const status = await git(dir, ['status', '--porcelain'])
    expect(status).toContain(' M a.txt')
    expect(status).toContain('A  staged.txt')
  })

  it('drops the signature only from commits that change', async () => {
    const { dir, shas } = await linearRepo()
    const raw = await git(dir, ['cat-file', 'commit', shas[3]])
    const signed = raw.replace('\n\n', '\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n')
    const signedSha = await gitLine(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signed })
    await git(dir, ['update-ref', 'refs/heads/main', signedSha])
    const preview = await previewRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    expect(preview.signaturesLost).toEqual([signedSha])
    await applyRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).not.toContain('gpgsig')
  })
})

describe('object writing', () => {
  it('writes valid objects that pass a full repository check', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['tag', '-a', 'v1', '-m', 'release', shas[2]])
    await applyRewrite(dir, {
      edits: { [shas[0]]: { message: 'Переименован ✓', authorName: 'Лёва', authorDate: '2020-01-02T03:04:05+05:00' } },
      sequence: { base: shas[1], tip: shas[3], todo: [{ sha: shas[3], action: 'pick' }, { sha: shas[2], action: 'pick' }] }
    })
    expect(await log(dir)).toEqual(['third', 'fourth', 'second', 'Переименован ✓'])
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
    expect(await gitLine(dir, ['cat-file', '-t', 'HEAD'])).toBe('commit')
  })

  it('is not affected by line-ending settings', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['config', 'core.autocrlf', 'true'])
    await applyRewrite(dir, { edits: { [shas[1]]: { message: 'line one\n\nline two' } } })
    expect(await git(dir, ['cat-file', 'commit', 'HEAD~2'])).not.toContain('\r')
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })
})

describe('old and unusual objects', () => {
  it('rewrites past a commit that fails format checks, keeping its bytes', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    const tree = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    const odd = `tree ${tree}\nparent ${first}\nauthor Old Timer <old@e> 0123456 +0000\ncommitter Old Timer <old@e> 0123456 +0000\n\nzero padded date\n`
    await expect(git(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: odd })).rejects.toThrow()
    const sha = await gitLine(dir, ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { input: odd })
    await git(dir, ['update-ref', 'refs/heads/main', sha])
    await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(await log(dir)).toEqual(['zero padded date', 'renamed'])
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).toContain('author Old Timer <old@e> 0123456 +0000')
  })

  it('moves a tag with no tagger line', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    const second = await commitFile(dir, 'b.txt', '2\n', 'second')
    const tag = await gitLine(dir, ['hash-object', '-t', 'tag', '-w', '--stdin', '--literally'], {
      input: `object ${second}\ntype commit\ntag ancient\n\nold release\n`
    })
    await git(dir, ['update-ref', 'refs/tags/ancient', tag])
    await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(await head(dir, 'ancient^{commit}')).toBe(await head(dir))
    expect(await git(dir, ['cat-file', 'tag', 'ancient'])).toContain('old release')
  })

  it('rebuilds a tag that points at another tag', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    const second = await commitFile(dir, 'b.txt', '2\n', 'second')
    await git(dir, ['tag', '-a', 'inner', '-m', 'inner tag', second])
    await git(dir, ['tag', '-a', 'outer', '-m', 'outer tag', 'inner'])
    expect(await gitLine(dir, ['cat-file', '-p', 'outer'])).toContain('type tag')
    await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    const newHead = await head(dir)
    expect(newHead).not.toBe(second)
    expect(await head(dir, 'outer^{commit}')).toBe(newHead)
    expect(await head(dir, 'inner^{commit}')).toBe(newHead)
    expect(await git(dir, ['cat-file', '-p', 'outer'])).toContain('outer tag')
    expect(await gitLine(dir, ['cat-file', '-t', 'outer^{tag}'])).toBe('tag')
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })

  it('removes a signature from a tag it moves', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    const second = await commitFile(dir, 'b.txt', '2\n', 'second')
    const signed = await gitLine(dir, ['hash-object', '-t', 'tag', '-w', '--stdin'], {
      input: `object ${second}\ntype commit\ntag v1\ntagger A <a@e> 1 +0000\n\nrelease\n-----BEGIN PGP SIGNATURE-----\nfake\n-----END PGP SIGNATURE-----\n`
    })
    await git(dir, ['update-ref', 'refs/tags/v1', signed])
    const { preview } = await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(preview.warnings.join()).toContain('Подпись тега v1')
    const text = await git(dir, ['cat-file', 'tag', 'v1'])
    expect(text).toContain('release')
    expect(text).not.toContain('SIGNATURE')
  })

  it('still rejects a broken edit instead of writing it', async () => {
    const { dir, shas } = await linearRepo()
    await expect(previewRewrite(dir, { edits: { [shas[1]]: { authorDate: 'not a date' } } })).rejects.toThrow('Некорректная дата')
  })
})

describe('sequence edits', () => {
  it('reorders commits and keeps the final tree', async () => {
    const { dir, shas } = await linearRepo()
    const tree = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    await applyRewrite(dir, {
      sequence: {
        base: shas[0],
        tip: shas[3],
        todo: [shas[3], shas[1], shas[2]].map((sha) => ({ sha, action: 'pick' as const }))
      }
    })
    expect(await log(dir)).toEqual(['third', 'second', 'fourth', 'first'])
    expect(await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
    expect(await gitLine(dir, ['log', '-1', '--format=%aI|%cI', 'HEAD'])).toBe(await gitLine(dir, ['log', '-1', '--format=%aI|%cI', shas[2]]))
  })

  it('keeps everything on top of the old tip above the reordered range', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['tag', 'at-tip', shas[3]])
    await git(dir, ['switch', '-c', 'above'])
    await commitFile(dir, 'above.txt', 'a\n', 'above tip')
    await git(dir, ['switch', 'main'])
    await applyRewrite(dir, {
      sequence: {
        base: shas[1],
        tip: shas[3],
        todo: [shas[3], shas[2]].map((sha) => ({ sha, action: 'pick' as const }))
      }
    })
    expect(await log(dir, 'above')).toEqual(['above tip', 'third', 'fourth', 'second', 'first'])
    expect(await log(dir, 'at-tip')).toEqual(['third', 'fourth', 'second', 'first'])
    expect(await head(dir, 'above~1')).toBe(await head(dir, 'main'))
  })

  it('reports a conflict and moves nothing', async () => {
    const dir = await createRepo()
    const a = await commitFile(dir, 'a.txt', '1\n', 'one')
    const b = await commitFile(dir, 'a.txt', '2\n', 'two')
    const c = await commitFile(dir, 'a.txt', '3\n', 'three')
    const plan = {
      sequence: { base: a, tip: c, todo: [c, b].map((sha) => ({ sha, action: 'pick' as const })) }
    }
    const preview = await previewRewrite(dir, plan)
    expect(preview.conflicts[0]?.files).toEqual(['a.txt'])
    expect(preview.refUpdates).toEqual([])
    await expect(applyRewrite(dir, plan)).rejects.toThrow('Конфликт')
    expect(await head(dir)).toBe(c)
    expect(await git(dir, ['status', '--porcelain'])).toBe('')
  })

  it('squashes messages together and fixup keeps only the first', async () => {
    const { dir, shas } = await linearRepo()
    const tree = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    await applyRewrite(dir, {
      sequence: {
        base: shas[0],
        tip: shas[3],
        todo: [
          { sha: shas[1], action: 'pick' },
          { sha: shas[2], action: 'squash' },
          { sha: shas[3], action: 'fixup' }
        ]
      }
    })
    expect(await log(dir)).toEqual(['second', 'first'])
    expect(await gitLine(dir, ['log', '-1', '--format=%B'])).toBe('second\n\nthird')
    expect(await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
    expect(await gitLine(dir, ['log', '-1', '--format=%an'])).toBe('Ann Author')
  })

  it('squash uses an edited message when one is given', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, {
      edits: { [shas[1]]: { message: 'combined' } },
      sequence: {
        base: shas[0],
        tip: shas[3],
        todo: [
          { sha: shas[1], action: 'pick' },
          { sha: shas[2], action: 'squash' },
          { sha: shas[3], action: 'pick' }
        ]
      }
    })
    expect(await log(dir)).toEqual(['fourth', 'combined', 'first'])
  })

  it('drops commits and updates the working tree', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, {
      sequence: {
        base: shas[1],
        tip: shas[3],
        todo: [{ sha: shas[2], action: 'pick' }, { sha: shas[3], action: 'drop' }]
      }
    })
    expect(await log(dir)).toEqual(['third', 'second', 'first'])
    expect(existsSync(join(dir, 'd.txt'))).toBe(false)
    expect(await git(dir, ['status', '--porcelain'])).toBe('')
  })

  it('refuses to change file contents under uncommitted work', async () => {
    const { dir, shas } = await linearRepo()
    write(dir, 'd.txt', 'edited\n')
    const plan = {
      sequence: { base: shas[2], tip: shas[3], todo: [{ sha: shas[3], action: 'drop' as const }] }
    }
    const preview = await previewRewrite(dir, plan)
    expect(preview.blockers.join()).toContain('незакоммиченные')
    await expect(applyRewrite(dir, plan)).rejects.toThrow('незакоммиченные')
    expect(await head(dir)).toBe(shas[3])
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('edited\n')
  })

  it('squashes a whole branch into one root commit', async () => {
    const { dir, shas } = await linearRepo()
    const tree = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    await applyRewrite(dir, {
      edits: { [shas[0]]: { message: 'Fresh start' } },
      sequence: {
        base: null,
        tip: shas[3],
        todo: [
          { sha: shas[0], action: 'pick' },
          { sha: shas[1], action: 'fixup' },
          { sha: shas[2], action: 'fixup' },
          { sha: shas[3], action: 'fixup' }
        ]
      }
    })
    expect(await log(dir)).toEqual(['Fresh start'])
    expect(await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(tree)
  })

  it('reattaches a branch that forked from a dropped commit', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['switch', '-c', 'side', shas[2]])
    await commitFile(dir, 'side.txt', 's\n', 'side work')
    await git(dir, ['switch', 'main'])
    await applyRewrite(dir, {
      sequence: {
        base: shas[1],
        tip: shas[3],
        todo: [{ sha: shas[2], action: 'drop' }, { sha: shas[3], action: 'pick' }]
      }
    })
    expect(await log(dir, 'side')).toEqual(['side work', 'second', 'first'])
    expect(await log(dir, 'main')).toEqual(['fourth', 'second', 'first'])
    expect(await git(dir, ['show', 'side:side.txt'])).toBe('s\n')
  })

  it('validates the todo list', async () => {
    const { dir, shas } = await linearRepo()
    await expect(previewRewrite(dir, {
      sequence: { base: shas[0], tip: shas[3], todo: [{ sha: shas[1], action: 'pick' }] }
    })).rejects.toThrow('не все коммиты')
    await expect(previewRewrite(dir, {
      sequence: { base: shas[2], tip: shas[3], todo: [{ sha: shas[3], action: 'squash' }] }
    })).rejects.toThrow('нельзя объединить')
    await expect(previewRewrite(dir, {
      sequence: { base: shas[1], tip: shas[3], todo: [{ sha: shas[2], action: 'drop' }, { sha: shas[3], action: 'drop' }] }
    })).resolves.toBeTruthy()
  })

  it('blocks removing every commit of a branch', async () => {
    const { dir, shas } = await linearRepo()
    const preview = await previewRewrite(dir, {
      sequence: { base: null, tip: shas[3], todo: shas.map((sha) => ({ sha, action: 'drop' as const })) }
    })
    expect(preview.blockers.join()).toContain('не останется коммитов')
  })

  it('refuses a merge commit that could not be recreated exactly', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'first')
    const toDrop = await commitFile(dir, 'b.txt', '2\n', 'to drop')
    const keep = await head(dir, 'HEAD~1')
    await git(dir, ['switch', '-c', 'feature', keep])
    await commitFile(dir, 'f.txt', 'f\n', 'feature')
    await git(dir, ['switch', 'main'])
    await mergeNoFf(dir, 'feature', 'merge')
    const preview = await previewRewrite(dir, {
      sequence: { base: keep, tip: toDrop, todo: [{ sha: toDrop, action: 'drop' }] }
    })
    expect(preview.conflicts[0]?.reason).toBe('merge-commit')
  })
})

describe('resolving conflicts during a rewrite', () => {
  async function swapped(): Promise<{ dir: string; plan: RewritePlan; b: string; c: string }> {
    const dir = await createRepo()
    const a = await commitFile(dir, 'a.txt', '1\n', 'one')
    const b = await commitFile(dir, 'a.txt', '2\n', 'two')
    const c = await commitFile(dir, 'a.txt', '3\n', 'three')
    return { dir, b, c, plan: { sequence: { base: a, tip: c, todo: [c, b].map((sha) => ({ sha, action: 'pick' as const })) } } }
  }

  it('describes each side of the conflict', async () => {
    const { dir, plan, c } = await swapped()
    const { conflicts } = await previewRewrite(dir, plan)
    expect(conflicts[0].sha).toBe(c)
    const file = conflicts[0].details![0]
    expect(file.path).toBe('a.txt')
    expect(await git(dir, ['cat-file', 'blob', file.ours!])).toBe('1\n')
    expect(await git(dir, ['cat-file', 'blob', file.theirs!])).toBe('3\n')
    expect(await git(dir, ['cat-file', 'blob', file.merged!])).toContain('<<<<<<<')
  })

  it('walks through conflicts one by one until the plan applies', async () => {
    const { dir, plan, b, c } = await swapped()
    const first = await previewRewrite(dir, { ...plan, resolutions: { [c]: { 'a.txt': { content: 'resolved three\n' } } } })
    expect(first.conflicts[0].sha).toBe(b)
    const full = { ...plan, resolutions: { [c]: { 'a.txt': { content: 'resolved three\n' } }, [b]: { 'a.txt': { content: 'final\n' } } } }
    expect((await previewRewrite(dir, full)).conflicts).toEqual([])
    await applyRewrite(dir, full)
    expect(await log(dir)).toEqual(['two', 'three', 'one'])
    expect(await git(dir, ['show', 'HEAD~1:a.txt'])).toBe('resolved three\n')
    expect(await git(dir, ['show', 'HEAD:a.txt'])).toBe('final\n')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('final\n')
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })

  it('accepts a chosen side, and deletion', async () => {
    const { dir, plan, b, c } = await swapped()
    const { conflicts } = await previewRewrite(dir, plan)
    const theirs = conflicts[0].details![0].theirs!
    await applyRewrite(dir, { ...plan, resolutions: { [c]: { 'a.txt': { blob: theirs } }, [b]: { 'a.txt': { deleted: true } } } })
    expect(await git(dir, ['show', 'HEAD~1:a.txt'])).toBe('3\n')
    expect(existsSync(join(dir, 'a.txt'))).toBe(false)
  })

  it('does not touch the real index or working tree while resolving', async () => {
    const { dir, plan, b, c } = await swapped()
    write(dir, 'untracked.txt', 'keep\n')
    write(dir, 'staged.txt', 'staged\n')
    await git(dir, ['add', 'staged.txt'])
    const before = await git(dir, ['status', '--porcelain'])
    await previewRewrite(dir, { ...plan, resolutions: { [c]: { 'a.txt': { content: 'x\n' } }, [b]: { 'a.txt': { content: 'y\n' } } } })
    expect(await git(dir, ['status', '--porcelain'])).toBe(before)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('3\n')
  })

  it('still conflicts when an answer covers only some files', async () => {
    const dir = await createRepo()
    const a = await commitFile(dir, 'x.txt', '1\n', 'one')
    await commitFile(dir, 'y.txt', '1\n', 'one y')
    write(dir, 'x.txt', '2\n')
    write(dir, 'y.txt', '2\n')
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-m', 'two'])
    const b = await head(dir)
    write(dir, 'x.txt', '3\n')
    write(dir, 'y.txt', '3\n')
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-m', 'three'])
    const c = await head(dir)
    const mid = await head(dir, 'HEAD~2')
    expect(a).not.toBe(mid)
    const preview = await previewRewrite(dir, {
      sequence: { base: mid, tip: c, todo: [c, b].map((sha) => ({ sha, action: 'pick' as const })) },
      resolutions: { [c]: { 'x.txt': { content: 'z\n' } } }
    })
    expect(preview.conflicts[0].files.sort()).toEqual(['x.txt', 'y.txt'])
  })

  it('resolves a conflict in a squash', async () => {
    const dir = await createRepo()
    const a = await commitFile(dir, 'a.txt', '1\n', 'one')
    const b = await commitFile(dir, 'a.txt', '2\n', 'two')
    const c = await commitFile(dir, 'a.txt', '3\n', 'three')
    const d = await commitFile(dir, 'a.txt', '4\n', 'four')
    const sequence = {
      base: a,
      tip: d,
      todo: [
        { sha: b, action: 'pick' as const },
        { sha: d, action: 'fixup' as const },
        { sha: c, action: 'drop' as const }
      ]
    }
    const preview = await previewRewrite(dir, { sequence })
    expect(preview.conflicts[0]?.sha).toBe(d)
    await applyRewrite(dir, { sequence, resolutions: { [d]: { 'a.txt': { content: 'merged\n' } } } })
    expect(await log(dir)).toEqual(['two', 'one'])
    expect(await git(dir, ['show', 'HEAD:a.txt'])).toBe('merged\n')
  })
})

describe('splitting commits', () => {
  const lines = (values: string[]): string => `${values.join('\n')}\n`
  const original = Array.from({ length: 30 }, (_, index) => `line ${index}`)

  async function bigCommit(): Promise<{ dir: string; base: string; big: string; files: FileDiff[] }> {
    const dir = await createRepo()
    const base = await commitFile(dir, 'a.txt', lines(original), 'base')
    const changed = [...original]
    changed[2] = 'first change'
    changed[25] = 'second change'
    write(dir, 'a.txt', lines(changed))
    write(dir, 'new.txt', 'new file\n')
    const big = await commitFile(dir, 'other.txt', 'other\n', 'big commit')
    const { files } = await commitDiff(dir, big)
    return { dir, base, big, files }
  }

  it('splits by hunk and by file, keeping the final tree and metadata', async () => {
    const { dir, base, big, files } = await bigCommit()
    const treeBefore = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    const a = files.find((file) => file.path === 'a.txt')!
    const added = files.find((file) => file.path === 'new.txt')!
    const patch = buildPatch([{ file: a, hunks: [0] }, { file: added, hunks: [0] }])
    await applyRewrite(dir, {
      edits: { [big]: { message: 'the rest' } },
      sequence: { base, tip: big, todo: [{ sha: big, action: 'pick', split: { patch, message: 'the first part' } }] }
    })
    expect(await log(dir)).toEqual(['the rest', 'the first part', 'base'])
    expect(await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])).toBe(treeBefore)
    const first = await git(dir, ['show', '--format=', 'HEAD~1'])
    expect(first).toContain('+first change')
    expect(first).not.toContain('+second change')
    expect(first).toContain('new.txt')
    expect(first).not.toContain('other.txt')
    const second = await git(dir, ['show', '--format=', 'HEAD'])
    expect(second).toContain('+second change')
    expect(second).toContain('other.txt')
    expect(await gitLine(dir, ['log', '-1', '--format=%an|%aI', 'HEAD~1'])).toBe(await gitLine(dir, ['log', '-1', '--format=%an|%aI', big]))
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })

  it('keeps later commits on top, and is undoable', async () => {
    const { dir, base, big, files } = await bigCommit()
    const later = await commitFile(dir, 'later.txt', 'l\n', 'later')
    const patch = buildPatch([{ file: files.find((file) => file.path === 'a.txt')!, hunks: [0] }])
    const { entry } = await applyRewrite(dir, {
      sequence: {
        base,
        tip: later,
        todo: [{ sha: big, action: 'pick', split: { patch, message: 'first' } }, { sha: later, action: 'pick' }]
      }
    })
    expect(await log(dir)).toEqual(['later', 'big commit', 'first', 'base'])
    await undoEntry(dir, entry.id)
    expect(await head(dir)).toBe(later)
  })

  it('splits the root commit', async () => {
    const dir = await createRepo()
    write(dir, 'a.txt', 'a\n')
    const root = await commitFile(dir, 'b.txt', 'b\n', 'everything')
    const { files } = await commitDiff(dir, root)
    await applyRewrite(dir, {
      sequence: {
        base: null,
        tip: root,
        todo: [{ sha: root, action: 'pick', split: { patch: buildPatch([{ file: files.find((file) => file.path === 'a.txt')!, hunks: [0] }]), message: 'just a' } }]
      }
    })
    expect(await log(dir)).toEqual(['everything', 'just a'])
    expect(await git(dir, ['show', 'HEAD~1:a.txt'])).toBe('a\n')
    await expect(git(dir, ['show', 'HEAD~1:b.txt'])).rejects.toThrow()
  })

  it('reports a split that no longer applies after a reorder', async () => {
    const { dir, base, big, files } = await bigCommit()
    const patch = buildPatch([{ file: files.find((file) => file.path === 'a.txt')!, hunks: [0] }])
    const garbled = patch.replace('line 0', 'something else entirely').replace('line 1', 'not there').replace('line 3', 'nope').replace('line 4', 'nor this')
    const preview = await previewRewrite(dir, {
      sequence: { base, tip: big, todo: [{ sha: big, action: 'pick', split: { patch: garbled, message: 'first' } }] }
    })
    expect(preview.conflicts[0]?.reason).toBe('split')
    expect(await head(dir)).toBe(big)
  })

  it('rejects splitting a commit that is also dropped', async () => {
    const { dir, base, big } = await bigCommit()
    await expect(previewRewrite(dir, {
      sequence: { base, tip: big, todo: [{ sha: big, action: 'drop', split: { patch: 'x', message: 'y' } }] }
    })).rejects.toThrow('Разделённый')
  })
})

describe('removing paths from history', () => {
  it('removes a file from every commit and every branch', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'secret.env', 'TOKEN=1\n', 'add secret')
    await commitFile(dir, 'dir/nested/key.pem', 'KEY\n', 'add key')
    await commitFile(dir, 'dir/keep.txt', 'keep\n', 'add keep')
    await git(dir, ['switch', '-c', 'side'])
    await commitFile(dir, 'secret.env', 'TOKEN=2\n', 'rotate secret')
    await git(dir, ['switch', 'main'])
    const before = await head(dir)
    await applyRewrite(dir, { removePaths: ['secret.env', 'dir/nested/key.pem'] })
    expect(await head(dir)).not.toBe(before)
    for (const branch of ['main', 'side']) {
      expect(await git(dir, ['log', '--format=%H', branch, '--', 'secret.env'])).toBe('')
      expect(await git(dir, ['log', '--format=%H', branch, '--', 'dir/nested/key.pem'])).toBe('')
    }
    expect(await git(dir, ['show', 'main:dir/keep.txt'])).toBe('keep\n')
    expect(existsSync(join(dir, 'secret.env'))).toBe(false)
    expect(await git(dir, ['status', '--porcelain'])).toBe('')
  })

  it('keeps file modes, nested paths and names with spaces or non-ASCII bytes', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'папка/файл один.txt', 'keep\n', 'first')
    write(dir, 'run.sh', '#!/bin/sh\n')
    chmodSync(join(dir, 'run.sh'), 0o755)
    write(dir, 'папка/секрет два.txt', 'secret\n')
    await git(dir, ['add', 'run.sh', 'папка/секрет два.txt'])
    await git(dir, ['update-index', '--chmod=+x', 'run.sh'])
    await git(dir, ['commit', '-q', '-m', 'second'])
    await applyRewrite(dir, { removePaths: ['папка/секрет два.txt'] })
    const listing = await git(dir, ['-c', 'core.quotePath=false', 'ls-tree', '-r', 'HEAD'])
    expect(listing).toContain('папка/файл один.txt')
    expect(listing).not.toContain('секрет')
    expect(listing).toMatch(/100755 blob \w+\trun\.sh/)
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })

  it('removes a whole directory, and drops parents left empty', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a/b/c.txt', '1\n', 'first')
    await commitFile(dir, 'keep.txt', 'k\n', 'second')
    await applyRewrite(dir, { removePaths: ['a/b/c.txt'] })
    expect((await git(dir, ['ls-tree', '--name-only', 'HEAD'])).trim()).toBe('keep.txt')
    await applyRewrite(dir, { removePaths: ['keep.txt'] })
    expect((await git(dir, ['ls-tree', 'HEAD'])).trim()).toBe('')
    await git(dir, ['fsck', '--full', '--no-dangling'])
  })

  it('prunes commits that become empty when asked', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'first')
    await commitFile(dir, 'secret.env', 'x\n', 'only secret')
    await commitFile(dir, 'b.txt', '2\n', 'second')
    await applyRewrite(dir, { removePaths: ['secret.env'], pruneEmpty: true })
    expect(await log(dir)).toEqual(['second', 'first'])
  })

  it('makes the data unreachable after backups are purged', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'first')
    const secretCommit = await commitFile(dir, 'secret.env', 'TOPSECRET\n', 'secret')
    const blob = await gitLine(dir, ['rev-parse', `${secretCommit}:secret.env`])
    await applyRewrite(dir, { removePaths: ['secret.env'] })
    expect(await gitLine(dir, ['cat-file', '-t', blob])).toBe('blob')
    await purgeBackups(dir)
    await expect(git(dir, ['cat-file', '-t', blob])).rejects.toThrow()
    expect(await readJournal(dir)).toEqual([])
  })
})

describe('signing rewritten commits', () => {
  const canSign = spawnSync('ssh-keygen', ['-?']).error === undefined

  async function signedRepo(): Promise<{ dir: string; first: string; signed: string }> {
    const dir = await createRepo()
    const keyDir = tempDir()
    const key = join(keyDir, 'key')
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'test'])
    await git(dir, ['config', 'gpg.format', 'ssh'])
    await git(dir, ['config', 'user.signingkey', key])
    const allowed = join(keyDir, 'allowed')
    writeFileSync(allowed, `* ${readFileSync(`${key}.pub`, 'utf8')}`)
    await git(dir, ['config', 'gpg.ssh.allowedSignersFile', allowed])
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    write(dir, 'b.txt', '2\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-S', '-q', '-m', 'signed commit\n\nwith a body'], {
      env: { GIT_AUTHOR_NAME: 'Ann Author', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_AUTHOR_DATE: '1700000500 +0300', GIT_COMMITTER_NAME: 'Лёва Коммиттер', GIT_COMMITTER_EMAIL: 'c@example.com', GIT_COMMITTER_DATE: '1700000600 -0500' }
    })
    const signed = await head(dir)
    await commitFile(dir, 'c.txt', '3\n', 'after')
    return { dir, first, signed }
  }

  it.skipIf(!canSign)('signs again only the commits that had a signature, keeping everything else', async () => {
    const { dir, first, signed } = await signedRepo()
    const metadata = await gitLine(dir, ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%cI|%B', signed])
    const preview = await previewRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(preview.signaturesLost).toEqual([signed])
    const { preview: applied } = await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } }, resign: true })
    expect(applied.signaturesLost).toEqual([])
    const middle = await head(dir, 'HEAD~1')
    await git(dir, ['verify-commit', middle])
    expect(await gitLine(dir, ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%cI|%B', middle])).toBe(metadata)
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).not.toContain('gpgsig')
    expect(await log(dir)).toEqual(['after', 'signed commit', 'renamed'])
    await git(dir, ['fsck', '--strict', '--full', '--no-dangling'])
  })

  it.skipIf(!canSign)('does not run the signer during a preview', async () => {
    const { dir, first } = await signedRepo()
    await git(dir, ['config', 'gpg.ssh.program', '/nonexistent/signer'])
    await expect(previewRewrite(dir, { edits: { [first]: { message: 'x' } }, resign: true })).resolves.toBeTruthy()
    await expect(applyRewrite(dir, { edits: { [first]: { message: 'x' } }, resign: true })).rejects.toThrow('подписать')
    expect(await log(dir)).toContain('first')
  })

  it.skipIf(!canSign)('falls back with a warning when a commit cannot be reproduced exactly', async () => {
    const { dir, first, signed } = await signedRepo()
    const raw = await git(dir, ['cat-file', 'commit', signed])
    const withExtra = raw.replace('\n\n', '\nmergetag object abc\n type commit\n\n')
    const odd = await gitLine(dir, ['hash-object', '-t', 'commit', '-w', '--stdin', '--literally'], { input: withExtra })
    await git(dir, ['update-ref', 'refs/heads/main', odd])
    const { preview } = await applyRewrite(dir, { edits: { [first]: { message: 'x' } }, resign: true })
    expect(preview.warnings.join()).toContain('необычного формата')
    expect(preview.signaturesLost).toEqual([odd])
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).toContain('mergetag')
  })

  it('reports whether signing is set up', async () => {
    const dir = await createRepo()
    await git(dir, ['config', 'user.signingkey', ''])
    expect((await signingSetup(dir)).available).toBe(false)
    await git(dir, ['config', 'user.signingkey', 'ABC123'])
    await git(dir, ['config', 'gpg.format', 'ssh'])
    expect(await signingSetup(dir)).toEqual({ available: true, format: 'ssh', key: 'ABC123' })
  })
})

describe('apply, undo and safety', () => {
  it('preview moves no refs', async () => {
    const { dir, shas } = await linearRepo()
    const preview = await previewRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    expect(preview.rewrittenCount).toBe(3)
    expect(await head(dir)).toBe(shas[3])
    expect(await log(dir)).toEqual(['fourth', 'third', 'second', 'first'])
  })

  it('undoes and redoes, restoring files and exact SHAs', async () => {
    const { dir, shas } = await linearRepo()
    const { entry } = await applyRewrite(dir, {
      sequence: { base: shas[2], tip: shas[3], todo: [{ sha: shas[3], action: 'drop' }] }
    })
    const applied = await head(dir)
    await undoEntry(dir, entry.id)
    expect(await head(dir)).toBe(shas[3])
    expect(existsSync(join(dir, 'd.txt'))).toBe(true)
    await redoEntry(dir, entry.id)
    expect(await head(dir)).toBe(applied)
    expect(existsSync(join(dir, 'd.txt'))).toBe(false)
    await undoEntry(dir, entry.id)
    expect((await readJournal(dir))[0].state).toBe('undone')
  })

  it('refuses to undo when the branch moved on, so no commit is lost', async () => {
    const { dir, shas } = await linearRepo()
    const { entry } = await applyRewrite(dir, { edits: { [shas[3]]: { message: 'x' } } })
    const newer = await commitFile(dir, 'e.txt', '5\n', 'newer')
    await expect(undoEntry(dir, entry.id)).rejects.toThrow('новые коммиты')
    expect(await head(dir)).toBe(newer)
  })

  it('keeps old commits reachable through backup refs', async () => {
    const { dir, shas } = await linearRepo()
    await applyRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    const refs = await git(dir, ['for-each-ref', '--format=%(objectname)', 'refs/chronicle/backup'])
    expect(refs.trim()).toBe(shas[3])
    await git(dir, ['gc', '--prune=now', '--quiet'])
    expect(await gitLine(dir, ['cat-file', '-t', shas[3]])).toBe('commit')
  })

  it('blocks rewriting during a merge in progress', async () => {
    const dir = await createRepo()
    const a = await commitFile(dir, 'a.txt', '1\n', 'base')
    await git(dir, ['switch', '-c', 'other'])
    await commitFile(dir, 'a.txt', 'other\n', 'other')
    await git(dir, ['switch', 'main'])
    await commitFile(dir, 'a.txt', 'main\n', 'main')
    await git(dir, ['merge', 'other'], { okCodes: [1] })
    const preview = await previewRewrite(dir, { edits: { [a]: { message: 'x' } } })
    expect(preview.blockers.join()).toContain('merge')
  })

  it('blocks a branch checked out in another worktree', async () => {
    const { dir, shas } = await linearRepo()
    await git(dir, ['worktree', 'add', '-q', '-b', 'wt', `${dir}-wt`, shas[3]])
    const preview = await previewRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    expect(preview.blockers.join()).toContain('worktree')
    await git(dir, ['worktree', 'remove', '--force', `${dir}-wt`])
  })

  it('flags pushed branches and never touches remote-tracking refs', async () => {
    const { dir, shas } = await linearRepo()
    await addOrigin(dir)
    const tracked = await head(dir, 'origin/main')
    const { preview } = await applyRewrite(dir, { edits: { [shas[1]]: { message: 'x' } } })
    expect(preview.refUpdates[0].needsForcePush).toBe(true)
    expect(await head(dir, 'origin/main')).toBe(tracked)
  })

  it('does not flag a push when only unpushed commits changed', async () => {
    const { dir } = await linearRepo()
    await addOrigin(dir)
    const local = await commitFile(dir, 'e.txt', '5\n', 'unpushed')
    const preview = await previewRewrite(dir, { edits: { [local]: { message: 'renamed' } } })
    expect(preview.refUpdates[0].needsForcePush).toBe(false)
  })

  it('preserves a message in a legacy encoding when only the parent changes', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'first')
    const tree = await gitLine(dir, ['rev-parse', 'HEAD^{tree}'])
    const koi8 = Buffer.concat([
      Buffer.from(`tree ${tree}\nparent ${first}\nauthor A <a@e> 1 +0000\ncommitter A <a@e> 1 +0000\nencoding KOI8-R\n\n`),
      Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4, 0x0a])
    ])
    const sha = await gitLine(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: koi8 })
    await git(dir, ['update-ref', 'refs/heads/main', sha])
    await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(await gitLine(dir, ['log', '-1', '--format=%s'])).toBe('Привет')
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).toContain('encoding KOI8-R')
    await applyRewrite(dir, { edits: { [await head(dir)]: { authorName: 'Лёва' } } })
    expect(await gitLine(dir, ['log', '-1', '--format=%an|%s'])).toBe('Лёва|Привет')
    expect(await git(dir, ['cat-file', 'commit', 'HEAD'])).not.toContain('encoding')
  })
})

describe('journal', () => {
  it('keeps every entry when several changes are recorded at once', async () => {
    const dir = await createRepo()
    const tip = await commitFile(dir, 'a.txt', '1\n', 'one')
    const names = Array.from({ length: 8 }, (_, index) => `refs/heads/b${index}`)
    await Promise.all(names.map((ref) => moveRefs(dir, [{ ref, before: null, after: tip }], ref)))
    expect((await readJournal(dir)).map((entry) => entry.description).sort()).toEqual([...names].sort())
  })
})
