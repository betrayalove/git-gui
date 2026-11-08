import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import {
  applyPatch, cloneRepository, commit, continueOperation, deleteRemoteBranch, discardFiles, fetchAll, forcePush, pull, push, pushPreview, renameBranch, renameRemoteBranch,
  readWorktreeConflicts, resolveWorktreeConflict, stageFiles, stashApply, stashClear, stashDrop, stashPush, unstageFiles
} from '../src/core/ops'
import { commitDiff, parseDiff, readBlob, readLog, readRefs, readRemotes, readStashes, readStatus, repoFingerprint, stashDiff, worktreeDiff } from '../src/core/read'
import { applyRewrite, rewrittenTagsOnRemote } from '../src/core/rewrite'
import { buildFilePatch } from '../src/shared/patch'
import { addOrigin, commitFile, createRepo, head, log, tempDir, write } from './helpers'

describe('reading', () => {
  it('reads an empty repository without failing', async () => {
    const dir = await createRepo()
    expect(await readLog(dir)).toEqual([])
    expect((await readStatus(dir)).headSha).toBeNull()
    expect(await readStashes(dir)).toEqual([])
  })

  it('parses log fields, including unicode and multi-line bodies', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'Заголовок\n\nТело\nвторая строка')
    const [entry] = await readLog(dir)
    expect(entry.subject).toBe('Заголовок')
    expect(entry.message).toBe('Заголовок\n\nТело\nвторая строка')
    expect(entry.authorName).toBe('Ann Author')
    expect(entry.authorDate).toMatch(/\+03:00$/)
    expect(entry.parents).toEqual([])
  })

  it('reads status for every kind of change', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a b.txt', '1\n', 'one')
    await commitFile(dir, 'old.txt', 'long enough content\nfor rename detection\n', 'two')
    write(dir, 'a b.txt', 'changed\n')
    write(dir, 'new file.txt', 'new\n')
    await git(dir, ['mv', 'old.txt', 'renamed.txt'])
    const status = await readStatus(dir)
    expect(status.head).toBe('main')
    expect(status.files).toContainEqual({ path: 'a b.txt', staged: undefined, unstaged: 'modified' })
    expect(status.files).toContainEqual({ path: 'new file.txt', unstaged: 'untracked' })
    expect(status.files).toContainEqual({ path: 'renamed.txt', origPath: 'old.txt', staged: 'renamed', unstaged: undefined })
  })

  it('parses diffs with spaces, renames, binaries and hunk-looking content', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'keep.txt', 'one\ntwo\nthree\n', 'base')
    write(dir, 'my file.txt', 'hello\n')
    write(dir, 'keep.txt', '--- not a header\ntwo\n+++ also not\n')
    write(dir, 'bin.dat', '\0\x01\x02')
    await git(dir, ['add', '--all'])
    await git(dir, ['commit', '-m', 'change'])
    const { files } = await commitDiff(dir, 'HEAD')
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]))
    expect(byPath['my file.txt'].status).toBe('added')
    expect(byPath['bin.dat'].binary).toBe(true)
    expect(byPath['keep.txt'].additions).toBe(2)
    expect(byPath['keep.txt'].deletions).toBe(2)
    expect(byPath['keep.txt'].hunks[0].lines.find((line) => line.type === 'add')?.text).toBe('--- not a header')
  })

  it('decodes quoted unicode paths', () => {
    const raw = 'diff --git "a/\\321\\204.txt" "b/\\321\\204.txt"\nnew file mode 100644\n--- /dev/null\n+++ "b/\\321\\204.txt"\n@@ -0,0 +1 @@\n+x\n'
    expect(parseDiff(raw).files[0].path).toBe('ф.txt')
  })

  it('shows diffs for untracked and staged files', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    write(dir, 'new.txt', 'hello\n')
    expect((await worktreeDiff(dir, 'new.txt', false, true)).files[0].additions).toBe(1)
    write(dir, 'a.txt', '2\n')
    await stageFiles(dir, ['a.txt'])
    expect((await worktreeDiff(dir, 'a.txt', true, false)).files[0].additions).toBe(1)
    expect((await worktreeDiff(dir, 'a.txt', false, false)).files).toEqual([])
  })

  it('changes the fingerprint when refs, the index or the stash change, but not on a plain edit', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const changes = async (action: () => Promise<unknown> | void): Promise<boolean> => {
      const before = await repoFingerprint(dir)
      await action()
      return (await repoFingerprint(dir)) !== before
    }
    expect(await changes(() => write(dir, 'a.txt', '2\n'))).toBe(false)
    expect(await changes(() => stageFiles(dir, ['a.txt']))).toBe(true)
    expect(await changes(() => stashPush(dir, 'wip', false))).toBe(true)
    expect(await changes(() => git(dir, ['branch', 'feature/deep/name']))).toBe(true)
    expect(await changes(() => commitFile(dir, 'b.txt', '1\n', 'two'))).toBe(true)
    expect(await changes(() => git(dir, ['pack-refs', '--all']))).toBe(true)
    expect(await changes(() => git(dir, ['remote', 'add', 'origin', tempDir()]))).toBe(true)
    expect(await changes(() => stashDrop(dir, 0))).toBe(true)
  })
})

describe('working tree', () => {
  it('stages, unstages, commits and amends', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    write(dir, 'b.txt', '2\n')
    await stageFiles(dir, ['b.txt'])
    expect((await readStatus(dir)).files[0].staged).toBe('added')
    await unstageFiles(dir, ['b.txt'])
    expect((await readStatus(dir)).files[0].unstaged).toBe('untracked')
    await stageFiles(dir, ['b.txt'])
    await commit(dir, { message: 'Заголовок\n\nТело' })
    expect(await log(dir)).toEqual(['Заголовок', 'one'])
    await commit(dir, { message: 'Новый заголовок', amend: true })
    expect(await log(dir)).toEqual(['Новый заголовок', 'one'])
  })

  it('unstages in a repository with no commits yet', async () => {
    const dir = await createRepo()
    write(dir, 'a.txt', '1\n')
    await stageFiles(dir, ['a.txt'])
    await unstageFiles(dir, ['a.txt'])
    expect((await readStatus(dir)).files[0].unstaged).toBe('untracked')
  })

  it('discards tracked and untracked changes', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    write(dir, 'a.txt', '2\n')
    write(dir, 'new.txt', 'x\n')
    await discardFiles(dir, ['a.txt'], ['new.txt'])
    expect(await git(dir, ['status', '--porcelain'])).toBe('')
    expect(existsSync(join(dir, 'new.txt'))).toBe(false)
  })

  it('touches only the named file when its name looks like a pattern', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'pages/[id].tsx', '1\n', 'one')
    await commitFile(dir, 'pages/i.tsx', '1\n', 'two')
    write(dir, 'pages/[id].tsx', '2\n')
    write(dir, 'pages/i.tsx', '2\n')
    write(dir, 'new/[slug].tsx', 'x\n')
    write(dir, 'new/s.tsx', 'keep\n')
    await stageFiles(dir, ['pages/[id].tsx'])
    expect(await git(dir, ['diff', '--cached', '--name-only'])).toBe('pages/[id].tsx\n')
    await unstageFiles(dir, ['pages/[id].tsx'])
    await discardFiles(dir, ['pages/[id].tsx'], ['new/[slug].tsx'])
    expect(await git(dir, ['status', '--porcelain', '--untracked-files=all'])).toBe(' M pages/i.tsx\n?? new/s.tsx\n')
  })
})

describe('stash', () => {
  it('lists, inspects, applies, drops and clears', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    write(dir, 'a.txt', '2\n')
    await stashPush(dir, 'first stash', false)
    write(dir, 'new.txt', 'u\n')
    await stashPush(dir, 'with untracked', true)
    const stashes = await readStashes(dir)
    expect(stashes.map((entry) => entry.message)).toEqual(['with untracked', 'first stash'])
    expect(stashes[0].branch).toBe('main')
    expect((await stashDiff(dir, stashes[0].sha)).files.map((file) => file.path)).toContain('new.txt')
    await stashApply(dir, 1, false)
    expect((await readStashes(dir)).length).toBe(2)
    await git(dir, ['checkout', '--', 'a.txt'])
    await stashDrop(dir, 0)
    expect((await readStashes(dir)).map((entry) => entry.message)).toEqual(['first stash'])
    await stashApply(dir, 0, true)
    expect(await readStashes(dir)).toEqual([])
    await git(dir, ['checkout', '--', 'a.txt'])
    write(dir, 'a.txt', '3\n')
    await stashPush(dir, 'to clear', false)
    await stashClear(dir)
    expect(await readStashes(dir)).toEqual([])
  })
})

describe('remote work', () => {
  it('pushes a new branch and sets its upstream', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    await addOrigin(dir)
    await git(dir, ['switch', '-c', 'feature'])
    await commitFile(dir, 'b.txt', '2\n', 'two')
    await push(dir, 'feature')
    const refs = await readRefs(dir)
    expect(refs.find((ref) => ref.name === 'feature')?.upstream).toBe('origin/feature')
    expect((await readRemotes(dir))[0].defaultBranch).toBe('main')
  })

  it('previews and performs a force-push after a rewrite', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'one')
    await commitFile(dir, 'b.txt', '2\n', 'two')
    const bare = await addOrigin(dir)
    const serverBefore = await head(bare, 'main')
    await applyRewrite(dir, { edits: { [first]: { message: 'one renamed' } } })
    await expect(push(dir, 'main')).rejects.toThrow()
    const preview = await pushPreview(dir, 'main')
    expect(preview.needsForce).toBe(true)
    expect(preview.remoteMoved).toBe(false)
    expect(preview.isDefaultBranch).toBe(true)
    expect(preview.appear.map((entry) => entry.subject)).toEqual(['two', 'one renamed'])
    expect(preview.vanish.map((entry) => entry.subject)).toEqual(['two', 'one'])
    await forcePush(dir, { branch: 'main', expectedRemoteSha: serverBefore })
    expect(await head(bare, 'main')).toBe(await head(dir))
    expect((await log(bare, 'main'))).toEqual(['two', 'one renamed'])
    expect((await readRefs(dir)).find((ref) => ref.name === 'main')?.ahead).toBe(0)
  })

  it('refuses a force-push when someone else pushed in the meantime', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'one')
    const bare = await addOrigin(dir)
    const seen = await head(bare, 'main')
    const other = tempDir()
    await git(other, ['clone', '-q', bare, '.'])
    await git(other, ['config', 'user.name', 'Other'])
    await git(other, ['config', 'user.email', 'other@example.com'])
    await commitFile(other, 'theirs.txt', 'x\n', 'their work')
    await git(other, ['push', '-q', 'origin', 'main'])
    const theirs = await head(other)
    await applyRewrite(dir, { edits: { [first]: { message: 'mine' } } })
    const preview = await pushPreview(dir, 'main')
    expect(preview.remoteMoved).toBe(true)
    expect(preview.vanish.map((entry) => entry.subject)).toContain('their work')
    await expect(forcePush(dir, { branch: 'main', expectedRemoteSha: seen })).rejects.toThrow()
    expect(await head(bare, 'main')).toBe(theirs)
  })

  it('force-pushes rewritten tags together with the branch', async () => {
    const dir = await createRepo()
    const first = await commitFile(dir, 'a.txt', '1\n', 'one')
    const second = await commitFile(dir, 'b.txt', '2\n', 'two')
    await git(dir, ['tag', '-a', 'v1', '-m', 'release', second])
    const bare = await addOrigin(dir)
    await git(dir, ['push', 'origin', 'v1'])
    const serverMain = await head(bare, 'main')
    const serverTag = await gitLine(bare, ['rev-parse', 'refs/tags/v1'])
    await applyRewrite(dir, { edits: { [first]: { message: 'renamed' } } })
    expect(await rewrittenTagsOnRemote(dir, 'origin')).toEqual([{ name: 'v1', expected: serverTag }])
    await forcePush(dir, { branch: 'main', expectedRemoteSha: serverMain, tags: [{ name: 'v1', expected: serverTag }] })
    expect(await rewrittenTagsOnRemote(dir, 'origin')).toEqual([])
    expect(await head(bare, 'refs/tags/v1^{commit}')).toBe(await head(dir))
  })

  it('pulls with fast-forward', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const bare = await addOrigin(dir)
    const other = tempDir()
    await git(other, ['clone', '-q', bare, '.'])
    await git(other, ['config', 'user.name', 'Other'])
    await git(other, ['config', 'user.email', 'other@example.com'])
    await commitFile(other, 'b.txt', '2\n', 'two')
    await git(other, ['push', '-q', 'origin', 'main'])
    await fetchAll(dir)
    expect((await readStatus(dir)).behind).toBe(1)
    await pull(dir, 'ff-only')
    expect(await log(dir)).toEqual(['two', 'one'])
  })
})

describe('cloning', () => {
  it('clones, and refuses transports that run commands', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const parent = tempDir()
    const root = await cloneRepository(dir, parent, 'copy')
    expect(await log(root)).toEqual(['one'])
    await expect(cloneRepository('ext::sh -c touch% /tmp/chronicle-pwned', parent, 'bad')).rejects.toThrow()
    await expect(cloneRepository('--upload-pack=touch', parent, 'bad2')).rejects.toThrow()
  })
})

describe('branch rename', () => {
  async function withFeature(): Promise<{ dir: string; bare: string }> {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const bare = await addOrigin(dir)
    await git(dir, ['switch', '-c', 'old-name'])
    await commitFile(dir, 'b.txt', '2\n', 'two')
    await push(dir, 'old-name')
    return { dir, bare }
  }

  it('renames locally only when asked', async () => {
    const { dir, bare } = await withFeature()
    const result = await renameBranch(dir, { oldName: 'old-name', newName: 'new-name', renameOnRemote: false })
    expect(result.localRenamed).toBe(true)
    expect(await head(bare, 'old-name')).toBeTruthy()
    await expect(git(bare, ['rev-parse', '--verify', 'new-name'])).rejects.toThrow()
  })

  it('renames on the server and moves the upstream', async () => {
    const { dir, bare } = await withFeature()
    const result = await renameBranch(dir, { oldName: 'old-name', newName: 'new-name', renameOnRemote: true })
    expect(result).toMatchObject({ localRenamed: true, remoteCreated: true, remoteDeleted: true, warnings: [] })
    expect(await head(bare, 'new-name')).toBe(await head(dir))
    await expect(git(bare, ['rev-parse', '--verify', 'old-name'])).rejects.toThrow()
    const local = (await readRefs(dir)).find((ref) => ref.name === 'new-name')
    expect(local?.upstream).toBe('origin/new-name')
    expect((await readRefs(dir)).some((ref) => ref.name === 'origin/old-name')).toBe(false)
  })

  it('does not publish unpushed local commits during a rename', async () => {
    const { dir, bare } = await withFeature()
    const server = await head(bare, 'old-name')
    await commitFile(dir, 'c.txt', '3\n', 'unpushed')
    await renameBranch(dir, { oldName: 'old-name', newName: 'new-name', renameOnRemote: true })
    expect(await head(bare, 'new-name')).toBe(server)
    expect((await readRefs(dir)).find((ref) => ref.name === 'new-name')?.ahead).toBe(1)
  })

  it('reports the default branch instead of failing silently', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const bare = await addOrigin(dir)
    await git(bare, ['config', 'receive.denyDeleteCurrent', 'refuse'])
    const result = await renameBranch(dir, { oldName: 'main', newName: 'trunk', renameOnRemote: true })
    expect(result.remoteCreated).toBe(true)
    expect(result.remoteDeleted).toBe(false)
    expect(result.warnings[0]).toContain('основная')
    expect(await head(bare, 'main')).toBe(await head(bare, 'trunk'))
  })

  it('rejects bad names and collisions and leaves the branch alone', async () => {
    const { dir } = await withFeature()
    await expect(renameBranch(dir, { oldName: 'old-name', newName: '--bad', renameOnRemote: true })).rejects.toThrow('Недопустимое')
    await expect(renameBranch(dir, { oldName: 'old-name', newName: 'main', renameOnRemote: true })).rejects.toThrow('уже существует')
    expect((await readRefs(dir)).some((ref) => ref.name === 'old-name')).toBe(true)
  })

  it('rolls the local rename back when the server name is taken', async () => {
    const { dir, bare } = await withFeature()
    await git(bare, ['branch', 'taken', 'main'])
    await expect(renameBranch(dir, { oldName: 'old-name', newName: 'taken', renameOnRemote: true })).rejects.toThrow('уже есть')
    expect((await readRefs(dir)).some((ref) => ref.name === 'old-name')).toBe(true)
  })

  it('renames and deletes remote-only branches', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const bare = await addOrigin(dir)
    await git(bare, ['branch', 'remote-only', 'main'])
    await fetchAll(dir)
    await renameRemoteBranch(dir, 'origin', 'remote-only', 'renamed')
    expect((await readRefs(dir)).map((ref) => ref.name)).toContain('origin/renamed')
    expect((await readRefs(dir)).map((ref) => ref.name)).not.toContain('origin/remote-only')
    await deleteRemoteBranch(dir, 'origin', 'renamed')
    await expect(git(bare, ['rev-parse', '--verify', 'renamed'])).rejects.toThrow()
  })
})

describe('hunks', () => {
  const lines = (values: string[]): string => `${values.join('\n')}\n`
  const original = Array.from({ length: 30 }, (_, index) => `line ${index}`)

  async function twoHunks(): Promise<string> {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', lines(original), 'base')
    const changed = [...original]
    changed[2] = 'first change'
    changed[25] = 'second change'
    write(dir, 'a.txt', lines(changed))
    return dir
  }

  it('stages only the chosen hunk', async () => {
    const dir = await twoHunks()
    const [file] = (await worktreeDiff(dir, 'a.txt', false, false)).files
    expect(file.hunks.length).toBe(2)
    await applyPatch(dir, buildFilePatch(file, [1]), { cached: true })
    const staged = await git(dir, ['diff', '--cached'])
    expect(staged).toContain('+second change')
    expect(staged).not.toContain('+first change')
    expect(await git(dir, ['diff'])).toContain('+first change')
  })

  it('unstages only the chosen hunk', async () => {
    const dir = await twoHunks()
    await stageFiles(dir, ['a.txt'])
    const [file] = (await worktreeDiff(dir, 'a.txt', true, false)).files
    await applyPatch(dir, buildFilePatch(file, [0]), { cached: true, reverse: true })
    expect(await git(dir, ['diff', '--cached'])).not.toContain('+first change')
    expect(await git(dir, ['diff', '--cached'])).toContain('+second change')
  })

  it('discards only the chosen hunk from the working tree', async () => {
    const dir = await twoHunks()
    const [file] = (await worktreeDiff(dir, 'a.txt', false, false)).files
    await applyPatch(dir, buildFilePatch(file, [0]), { reverse: true })
    const diff = await git(dir, ['diff'])
    expect(diff).not.toContain('first change')
    expect(diff).toContain('+second change')
  })

  it('handles a file with no trailing newline', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', 'one\ntwo', 'base')
    write(dir, 'a.txt', 'one\nthree')
    const [file] = (await worktreeDiff(dir, 'a.txt', false, false)).files
    await applyPatch(dir, buildFilePatch(file, [0]), { cached: true })
    expect(await git(dir, ['show', ':a.txt'])).toBe('one\nthree')
  })

  it('handles non-ASCII paths and content', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'папка/файл с пробелом.txt', 'старое\n', 'base')
    write(dir, 'папка/файл с пробелом.txt', 'новое\n')
    const [file] = (await worktreeDiff(dir, 'папка/файл с пробелом.txt', false, false)).files
    expect(file.path).toBe('папка/файл с пробелом.txt')
    await applyPatch(dir, buildFilePatch(file, [0]), { cached: true })
    expect(await git(dir, ['show', ':папка/файл с пробелом.txt'])).toBe('новое\n')
  })
})

describe('conflicts in the working tree', () => {
  async function conflicted(): Promise<string> {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', 'base\n', 'base')
    await git(dir, ['switch', '-c', 'other'])
    await commitFile(dir, 'a.txt', 'theirs\n', 'other')
    await git(dir, ['switch', 'main'])
    await commitFile(dir, 'a.txt', 'ours\n', 'main')
    await git(dir, ['merge', 'other'], { okCodes: [1] })
    return dir
  }

  it('lists the sides of a conflict', async () => {
    const dir = await conflicted()
    const [conflict] = await readWorktreeConflicts(dir)
    expect(conflict.path).toBe('a.txt')
    expect((await readBlob(dir, conflict.ours!)).text).toBe('ours\n')
    expect((await readBlob(dir, conflict.theirs!)).text).toBe('theirs\n')
    expect(conflict.mergedContent?.text).toContain('<<<<<<<')
  })

  it('resolves with custom content and finishes the merge', async () => {
    const dir = await conflicted()
    await resolveWorktreeConflict(dir, 'a.txt', { content: 'combined\n' })
    expect(await readWorktreeConflicts(dir)).toEqual([])
    await continueOperation(dir, 'merge')
    expect(await git(dir, ['show', 'HEAD:a.txt'])).toBe('combined\n')
    expect((await readStatus(dir)).operation).toBeUndefined()
    expect(await gitLine(dir, ['log', '-1', '--format=%p']).then((parents) => parents.split(' ').length)).toBe(2)
  })

  it('resolves by choosing a side or deleting the file', async () => {
    const dir = await conflicted()
    const [conflict] = await readWorktreeConflicts(dir)
    await resolveWorktreeConflict(dir, 'a.txt', { blob: conflict.theirs! })
    expect(await git(dir, ['show', ':a.txt'])).toBe('theirs\n')
    const other = await conflicted()
    await resolveWorktreeConflict(other, 'a.txt', { deleted: true })
    expect(existsSync(join(other, 'a.txt'))).toBe(false)
    expect(await readWorktreeConflicts(other)).toEqual([])
  })

  it('refuses paths that are not in conflict', async () => {
    const dir = await conflicted()
    await expect(resolveWorktreeConflict(dir, '../outside.txt', { content: 'x' })).rejects.toThrow()
    await expect(resolveWorktreeConflict(dir, 'other.txt', { content: 'x' })).rejects.toThrow('не в конфликте')
    expect(existsSync(join(dir, 'other.txt'))).toBe(false)
  })
})
