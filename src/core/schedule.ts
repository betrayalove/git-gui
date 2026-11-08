import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { classifyAccessError, issueSummary } from '../shared/access'
import type { CommitEdit, ScheduledPublish } from '../shared/types'
import { git, GitError, isAncestor, revParse, runGit } from './git'
import { lsRemoteBranch, resolveBranchTarget } from './ops'
import { exclusive } from './exclusive'
import { commonDir, readCommits } from './read'
import { moveRefs, replayOnto } from './rewrite'
import { t } from '../shared/i18n'

async function storePath(cwd: string): Promise<string> {
  return join(await commonDir(cwd), 'chronicle', 'schedules.json')
}

export async function listSchedules(cwd: string): Promise<ScheduledPublish[]> {
  try {
    return JSON.parse(await readFile(await storePath(cwd), 'utf8')) as ScheduledPublish[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function saveSchedules(cwd: string, schedules: ScheduledPublish[]): Promise<void> {
  const path = await storePath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(schedules, null, 2))
  await rename(temporary, path)
}

/** Reads, changes and writes the list as one step, so that changes arriving together all survive. */
async function changeSchedules<T>(cwd: string, change: (schedules: ScheduledPublish[]) => { schedules: ScheduledPublish[]; result: T }): Promise<T> {
  return exclusive(await storePath(cwd), async () => {
    const { schedules, result } = change(await listSchedules(cwd))
    await saveSchedules(cwd, schedules)
    return result
  })
}

async function updateSchedule(cwd: string, id: string, patch: Partial<ScheduledPublish>): Promise<ScheduledPublish> {
  return changeSchedules(cwd, (schedules) => {
    const entry = schedules.find((item) => item.id === id)
    if (!entry) throw new Error(t('Публикация не найдена'))
    Object.assign(entry, patch)
    return { schedules, result: entry }
  })
}

function keeperRef(id: string): string {
  return `refs/chronicle/scheduled/${id}`
}

export interface ScheduleRequest {
  branch: string
  count: number
  at: string
  dateMode: 'keep' | 'publish-time'
  remote?: string
}

/**
 * Takes the last commits off a branch, locally and on the server, and remembers them for later.
 * If the server refuses the removal, the local branch is restored and nothing is scheduled.
 */
export async function schedulePublish(cwd: string, request: ScheduleRequest): Promise<ScheduledPublish> {
  if (!Number.isInteger(request.count) || request.count < 1) throw new Error(t('Нужно выбрать хотя бы один коммит'))
  if (Number.isNaN(Date.parse(request.at))) throw new Error(t('Некорректное время публикации'))
  const target = await resolveBranchTarget(cwd, request.branch, request.remote)
  const tip = target.localSha
  const commits = (await readCommits(cwd, ['--first-parent', `--max-count=${request.count}`, tip]))
  if (commits.length < request.count) throw new Error(t('В ветке меньше коммитов, чем выбрано'))
  if (commits.some((commit) => commit.parents.length !== 1)) {
    throw new Error(t('Нельзя снять merge-коммит или самый первый коммит ветки'))
  }
  const base = commits.at(-1)!.parents[0]
  const held = [...commits].reverse()

  const remoteSha = await lsRemoteBranch(cwd, target.remote, target.remoteBranch)
  let removeFromServer = false
  if (remoteSha) {
    await git(cwd, ['fetch', '--', target.remote, `+refs/heads/${target.remoteBranch}:refs/remotes/${target.remote}/${target.remoteBranch}`])
    if (!(await isAncestor(cwd, remoteSha, base))) {
      const onTheWay = (await isAncestor(cwd, base, remoteSha)) && (await isAncestor(cwd, remoteSha, tip))
      if (!onTheWay) throw new Error(t('На сервере есть коммиты, которых нет локально. Сначала подтяни изменения.'))
      removeFromServer = true
    }
  }

  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  await git(cwd, ['update-ref', keeperRef(id), tip])
  const branchRef = `refs/heads/${request.branch}`
  try {
    await moveRefs(cwd, [{ ref: branchRef, before: tip, after: base }], t('Снятие коммитов для публикации: {branch}', { branch: request.branch }))
    if (removeFromServer) {
      try {
        await git(cwd, [
          'push', `--force-with-lease=refs/heads/${target.remoteBranch}:${remoteSha}`, '--',
          target.remote, `${base}:refs/heads/${target.remoteBranch}`
        ])
        await git(cwd, ['update-ref', `refs/remotes/${target.remote}/${target.remoteBranch}`, base])
      } catch (error) {
        await moveRefs(cwd, [{ ref: branchRef, before: base, after: tip }], t('Возврат коммитов: {branch}', { branch: request.branch }))
        throw error
      }
    }
  } catch (error) {
    await git(cwd, ['update-ref', '-d', keeperRef(id)])
    throw error
  }

  const entry: ScheduledPublish = {
    id,
    repo: cwd,
    branch: request.branch,
    remote: target.remote,
    at: new Date(request.at).toISOString(),
    dateMode: request.dateMode,
    base,
    tip,
    commits: held.map((commit) => ({ sha: commit.sha, subject: commit.subject })),
    state: 'pending'
  }
  await changeSchedules(cwd, (schedules) => ({ schedules: [...schedules, entry], result: null }))
  return entry
}

function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const pad = (value: number): string => String(Math.floor(Math.abs(value))).padStart(2, '0')
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

const running = new Set<string>()

export async function publishNow(cwd: string, id: string, now: Date = new Date()): Promise<ScheduledPublish> {
  if (running.has(id)) throw new Error(t('Эта публикация уже выполняется'))
  running.add(id)
  try {
    const entry = (await listSchedules(cwd)).find((item) => item.id === id)
    if (!entry) throw new Error(t('Публикация не найдена'))
    if (entry.state !== 'pending') throw new Error(t('Эта публикация уже завершена'))
    return await publish(cwd, entry, now)
  } finally {
    running.delete(id)
  }
}

async function publish(cwd: string, entry: ScheduledPublish, now: Date): Promise<ScheduledPublish> {
  const target = await resolveBranchTarget(cwd, entry.branch, entry.remote)
  const remoteRef = `refs/remotes/${target.remote}/${target.remoteBranch}`
  let remoteSha: string | null
  try {
    remoteSha = await lsRemoteBranch(cwd, target.remote, target.remoteBranch)
    if (remoteSha) await git(cwd, ['fetch', '--', target.remote, `+refs/heads/${target.remoteBranch}:${remoteRef}`])
  } catch (error) {
    // Most likely offline. The schedule stays pending and the next tick retries it.
    return updateSchedule(cwd, entry.id, { error: (error as Error).message })
  }

  const stamp = localIso(now)
  const editFor = (): CommitEdit | undefined =>
    entry.dateMode === 'publish-time' ? { authorDate: stamp, committerDate: stamp } : undefined
  const onto = remoteSha ?? entry.base
  const replay = await replayOnto(cwd, entry.commits.map((commit) => commit.sha), onto, editFor)
  if (!replay.tip) {
    return updateSchedule(cwd, entry.id, {
      state: 'failed',
      error: t('Конфликт с новыми коммитами на сервере в «{subject}»: {value}. Коммиты сохранены.', { subject: replay.conflict!.subject, value: replay.conflict!.files.join(', ') })
    })
  }

  try {
    await git(cwd, ['push', '--', target.remote, `${replay.tip}:refs/heads/${target.remoteBranch}`])
  } catch (error) {
    return updateSchedule(cwd, entry.id, { error: (error as GitError).message })
  }
  await git(cwd, ['update-ref', remoteRef, replay.tip])

  let note: string | undefined
  const branchRef = `refs/heads/${entry.branch}`
  const localSha = await revParse(cwd, branchRef)
  if (localSha && localSha !== replay.tip) {
    if (await isAncestor(cwd, localSha, replay.tip)) {
      try {
        await moveRefs(cwd, [{ ref: branchRef, before: localSha, after: replay.tip }], t('Публикация: {branch}', { branch: entry.branch }))
      } catch {
        note = t('Коммиты опубликованы. Локальная ветка не обновлена из-за правок в рабочей папке, подтяни изменения позже.')
      }
    } else {
      note = t('Коммиты опубликованы. В локальной ветке есть новые коммиты, поэтому нужно подтянуть изменения.')
    }
  }
  await runGit(cwd, ['update-ref', '-d', keeperRef(entry.id)])
  return updateSchedule(cwd, entry.id, { state: 'done', publishedSha: replay.tip, error: undefined, note })
}

export async function publishDue(cwd: string, now: Date = new Date()): Promise<ScheduledPublish[]> {
  const due = (await listSchedules(cwd))
    .filter((item) => item.state === 'pending' && Date.parse(item.at) <= now.getTime())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const results: ScheduledPublish[] = []
  for (const item of due) {
    if (running.has(item.id)) continue
    results.push(await publishNow(cwd, item.id, now))
  }
  return results
}

/**
 * What to tell the person, once, about a publish that keeps waiting. Null while it only waits for
 * the network, which comes back by itself. Any other refusal repeats until someone acts.
 */
export function waitingNotice(entry: ScheduledPublish): { title: string; body: string } | null {
  if (entry.state !== 'pending' || !entry.error) return null
  const issue = classifyAccessError(entry.error)
  if (issue === 'offline') return null
  if (issue) return { title: t('Публикация ждёт доступа: {branch}', { branch: entry.branch }), body: issueSummary(issue) }
  return {
    title: t('Публикация не проходит: {branch}', { branch: entry.branch }),
    body: t('Сервер не принял коммиты, попытки продолжатся. Скорее всего, нужно что-то исправить: {error}', { error: entry.error })
  }
}

/** Cancels a publish and puts the commits back on the local branch. The server is left alone. */
export async function cancelSchedule(cwd: string, id: string): Promise<ScheduledPublish> {
  const entry = (await listSchedules(cwd)).find((item) => item.id === id)
  if (!entry) throw new Error(t('Публикация не найдена'))
  if (entry.state === 'done' || entry.state === 'cancelled') throw new Error(t('Эта публикация уже завершена'))
  const branchRef = `refs/heads/${entry.branch}`
  const localSha = await revParse(cwd, branchRef)
  if (!localSha) throw new Error(t('Ветка {branch} не найдена', { branch: entry.branch }))
  const replay = await replayOnto(cwd, entry.commits.map((commit) => commit.sha), localSha)
  if (!replay.tip) {
    throw new Error(t('Коммит «{subject}» конфликтует с локальной веткой. Сначала разреши это вручную.', { subject: replay.conflict!.subject }))
  }
  await moveRefs(cwd, [{ ref: branchRef, before: localSha, after: replay.tip }], t('Возврат коммитов: {branch}', { branch: entry.branch }))
  await runGit(cwd, ['update-ref', '-d', keeperRef(id)])
  return updateSchedule(cwd, id, { state: 'cancelled', note: t('Коммиты возвращены в локальную ветку.') })
}

export async function dismissSchedule(cwd: string, id: string): Promise<void> {
  await changeSchedules(cwd, (schedules) => {
    if (schedules.find((item) => item.id === id)?.state === 'pending') throw new Error(t('Сначала отмени публикацию'))
    return { schedules: schedules.filter((item) => item.id !== id), result: null }
  })
}

