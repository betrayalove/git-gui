import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, gitLine } from '../src/core/git'
import { cancelSchedule, dismissSchedule, listSchedules, publishDue, publishNow, schedulePublish, waitingNotice } from '../src/core/schedule'
import type { ScheduledPublish } from '../src/shared/types'
import { addOrigin, commitFile, createRepo, head, log, tempDir, write } from './helpers'

async function pushedRepo(): Promise<{ dir: string; bare: string; tip: string }> {
  const dir = await createRepo()
  await commitFile(dir, 'a.txt', '1\n', 'one')
  await commitFile(dir, 'b.txt', '2\n', 'two')
  const tip = await commitFile(dir, 'c.txt', '3\n', 'three')
  const bare = await addOrigin(dir)
  return { dir, bare, tip }
}

const future = '2099-01-01T10:00:00.000Z'

describe('scheduled publishing', () => {
  it('removes commits locally and from the server, then republishes the same SHAs', async () => {
    const { dir, bare, tip } = await pushedRepo()
    const entry = await schedulePublish(dir, { branch: 'main', count: 2, at: future, dateMode: 'keep' })
    expect(await log(dir)).toEqual(['one'])
    expect(await log(bare, 'main')).toEqual(['one'])
    expect(existsSync(join(dir, 'c.txt'))).toBe(false)
    expect(entry.commits.map((commit) => commit.subject)).toEqual(['two', 'three'])
    expect(await publishDue(dir, new Date('2098-01-01T00:00:00Z'))).toEqual([])
    const [result] = await publishDue(dir, new Date('2099-01-01T10:00:01Z'))
    expect(result.state).toBe('done')
    expect(await head(bare, 'main')).toBe(tip)
    expect(await head(dir)).toBe(tip)
    expect(existsSync(join(dir, 'c.txt'))).toBe(true)
    expect(await head(dir, 'origin/main')).toBe(tip)
  })

  it('holds back commits that were never pushed without touching the server', async () => {
    const { dir, bare, tip } = await pushedRepo()
    const local = await commitFile(dir, 'd.txt', '4\n', 'local only')
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    expect(await head(dir)).toBe(tip)
    expect(await head(bare, 'main')).toBe(tip)
    await publishDue(dir, new Date(future))
    expect(await head(bare, 'main')).toBe(local)
  })

  it('stamps the publish time when asked', async () => {
    const { dir, bare } = await pushedRepo()
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'publish-time' })
    const publishedAt = new Date('2099-03-04T05:06:07Z')
    await publishNow(dir, (await listSchedules(dir))[0].id, publishedAt)
    const seconds = Math.floor(publishedAt.getTime() / 1000)
    expect(await gitLine(bare, ['log', '-1', '--format=%at|%ct', 'main'])).toBe(`${seconds}|${seconds}`)
  })

  it('stacks on top of commits others pushed while waiting', async () => {
    const { dir, bare } = await pushedRepo()
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    const other = tempDir()
    await git(other, ['clone', '-q', bare, '.'])
    await commitFile(other, 'theirs.txt', 'x\n', 'their work')
    await git(other, ['push', '-q', 'origin', 'main'])
    const [result] = await publishDue(dir, new Date(future))
    expect(result.state).toBe('done')
    expect(await log(bare, 'main')).toEqual(['three', 'their work', 'two', 'one'])
    expect(await head(dir)).toBe(result.publishedSha)
  })

  it('fails safely on a conflict, keeps the commits and can restore them', async () => {
    const { dir, bare, tip } = await pushedRepo()
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    const other = tempDir()
    await git(other, ['clone', '-q', bare, '.'])
    await commitFile(other, 'c.txt', 'conflict\n', 'their c')
    await git(other, ['push', '-q', 'origin', 'main'])
    const serverTip = await head(bare, 'main')
    const [result] = await publishDue(dir, new Date(future))
    expect(result.state).toBe('failed')
    expect(result.error).toContain('c.txt')
    expect(await head(bare, 'main')).toBe(serverTip)
    expect(await gitLine(dir, ['cat-file', '-t', tip])).toBe('commit')
    const cancelled = await cancelSchedule(dir, result.id)
    expect(cancelled.state).toBe('cancelled')
    expect(await head(dir)).toBe(tip)
  })

  it('keeps a publish pending when the server is unreachable, then retries', async () => {
    const { dir, bare, tip } = await pushedRepo()
    const entry = await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    await git(dir, ['remote', 'set-url', 'origin', join(bare, 'missing')])
    const [offline] = await publishDue(dir, new Date(future))
    expect(offline.state).toBe('pending')
    expect(offline.error).toBeTruthy()
    await git(dir, ['remote', 'set-url', 'origin', bare])
    const [online] = await publishDue(dir, new Date(future))
    expect(online.id).toBe(entry.id)
    expect(online.state).toBe('done')
    expect(online.error).toBeUndefined()
    expect(await head(bare, 'main')).toBe(tip)
  })

  it('cancels, restoring commits on the local branch', async () => {
    const { dir, tip } = await pushedRepo()
    const entry = await schedulePublish(dir, { branch: 'main', count: 2, at: future, dateMode: 'keep' })
    await cancelSchedule(dir, entry.id)
    expect(await head(dir)).toBe(tip)
    expect(await git(dir, ['for-each-ref', 'refs/chronicle/scheduled'])).toBe('')
  })

  it('leaves the local branch alone when it moved on, and tells the user', async () => {
    const { dir, bare } = await pushedRepo()
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    const newer = await commitFile(dir, 'newer.txt', 'n\n', 'newer local')
    const [result] = await publishDue(dir, new Date(future))
    expect(result.state).toBe('done')
    expect(result.note).toContain('подтянуть')
    expect(await head(dir)).toBe(newer)
    expect(await log(bare, 'main')).toEqual(['three', 'two', 'one'])
  })

  it('publishes but keeps uncommitted work untouched when files would change', async () => {
    const { dir, bare, tip } = await pushedRepo()
    await schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })
    write(dir, 'a.txt', 'dirty\n')
    const [result] = await publishDue(dir, new Date(future))
    expect(result.state).toBe('done')
    expect(result.note).toContain('рабочей папке')
    expect(await head(bare, 'main')).toBe(tip)
    expect(await git(dir, ['status', '--porcelain'])).toContain(' M a.txt')
  })

  it('refuses invalid requests and changes nothing', async () => {
    const { dir, tip } = await pushedRepo()
    await expect(schedulePublish(dir, { branch: 'main', count: 0, at: future, dateMode: 'keep' })).rejects.toThrow()
    await expect(schedulePublish(dir, { branch: 'main', count: 3, at: future, dateMode: 'keep' })).rejects.toThrow('первый')
    await expect(schedulePublish(dir, { branch: 'main', count: 1, at: 'nonsense', dateMode: 'keep' })).rejects.toThrow('Некорректное')
    expect(await head(dir)).toBe(tip)
    expect(await listSchedules(dir)).toEqual([])
  })

  it('refuses when the server has commits that are not local', async () => {
    const { dir, bare, tip } = await pushedRepo()
    const other = tempDir()
    await git(other, ['clone', '-q', bare, '.'])
    await commitFile(other, 'x.txt', 'x\n', 'server only')
    await git(other, ['push', '-q', 'origin', 'main'])
    await expect(schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })).rejects.toThrow('подтяни')
    expect(await head(dir)).toBe(tip)
  })

  it('restores the local branch when the server refuses the removal', async () => {
    const { dir, bare, tip } = await pushedRepo()
    await git(bare, ['config', 'receive.denyNonFastForwards', 'true'])
    await expect(schedulePublish(dir, { branch: 'main', count: 1, at: future, dateMode: 'keep' })).rejects.toThrow()
    expect(await head(dir)).toBe(tip)
    expect(await git(dir, ['for-each-ref', 'refs/chronicle/scheduled'])).toBe('')
    expect(await listSchedules(dir)).toEqual([])
  })
})

describe('waiting notices', () => {
  const waiting = (error?: string): ScheduledPublish => ({
    id: 'x', repo: '/repo', branch: 'main', remote: 'origin', at: future, dateMode: 'keep',
    base: 'a', tip: 'b', commits: [], state: 'pending', ...(error ? { error } : {})
  })

  it('tells about a refusal nobody recognized, so it does not repeat silently', () => {
    const notice = waitingNotice(waiting('remote: error: GH001: Large files detected.'))
    expect(notice?.title).toBe('Публикация не проходит: main')
    expect(notice?.body).toContain('GH001: Large files detected')
  })

  it('names an access problem and stays quiet while offline', () => {
    expect(waitingNotice(waiting('git@github.com: Permission denied (publickey).'))?.title).toBe('Публикация ждёт доступа: main')
    expect(waitingNotice(waiting('ssh: Could not resolve hostname github.com'))).toBeNull()
    expect(waitingNotice(waiting())).toBeNull()
  })
})

describe('schedule records', () => {
  it('keeps every change when several arrive at once', async () => {
    const dir = await createRepo()
    await commitFile(dir, 'a.txt', '1\n', 'one')
    const done = Array.from({ length: 8 }, (_, index): ScheduledPublish => ({
      id: `done-${index}`, repo: dir, branch: 'main', remote: 'origin', at: future, dateMode: 'keep',
      base: 'a', tip: 'b', commits: [], state: 'done'
    }))
    mkdirSync(join(dir, '.git', 'chronicle'), { recursive: true })
    writeFileSync(join(dir, '.git', 'chronicle', 'schedules.json'), JSON.stringify(done))
    await Promise.all(done.map((entry) => dismissSchedule(dir, entry.id)))
    expect(await listSchedules(dir)).toEqual([])
  })
})
