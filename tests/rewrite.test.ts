import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { applyRewrite, previewRewrite, purgeBackups, readJournal, redoEntry, undoEntry } from '../src/core/rewrite'
import { addOrigin, commitFile, createRepo, head, log, mergeNoFf, resetClock, write } from './helpers'

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
