import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Commit, RewritePreview } from '../../../shared/types'
import { formatRelative, shortSha } from '../format'
import { useRepo } from '../store'
import { Avatar } from './ui'

const SHOWN = 30

/**
 * The branch as it will look after applying: its new commits on top of what stays. The objects
 * already exist from the preview, so this reads the real result, not a guess.
 */
export function ResultHistory({ preview }: { preview: RewritePreview }): ReactNode {
  const { client, snapshot } = useRepo()
  const branches = preview.refUpdates.filter((update) => update.kind === 'branch')
  const preferred = branches.find((update) => update.name === snapshot?.status.head) ?? branches[0]
  const [name, setName] = useState(preferred?.name)
  const update = branches.find((item) => item.name === name) ?? preferred
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const created = useMemo(() => new Set(Object.values(preview.mapping).filter(Boolean)), [preview.mapping])

  useEffect(() => {
    if (!update) return
    let cancelled = false
    setCommits(null)
    client.readLog({ revs: [update.afterCommit], limit: SHOWN })
      .then((list) => { if (!cancelled) setCommits(list) })
      .catch(() => { if (!cancelled) setCommits([]) })
    return () => { cancelled = true }
  }, [client, update])

  if (!update) return null
  // Rows below the last rewritten one are unchanged history. A few of them give context.
  const lastNew = commits ? commits.findLastIndex((commit) => created.has(commit.sha)) : -1
  const visible = commits?.slice(0, Math.max(lastNew + 4, 6)) ?? []
  return (
    <section className="result-history" aria-label="Как будет выглядеть ветка">
      <header>
        <h4>Как будет выглядеть ветка</h4>
        {branches.length > 1
          ? (
            <select value={update.name} aria-label="Ветка" onChange={(event) => setName(event.target.value)}>
              {branches.map((item) => <option key={item.ref} value={item.name}>{item.name}</option>)}
            </select>
          )
          : <b>{update.name}</b>}
      </header>
      {!commits && <div className="diff-loading">Читаю новую историю…</div>}
      <ol>
        {visible.map((commit) => {
          const isNew = created.has(commit.sha)
          return (
            <li key={commit.sha} className={isNew ? 'new' : ''}>
              <span className="result-dot" />
              <span className="truncate result-subject">{commit.subject}</span>
              <Avatar name={commit.authorName} email={commit.authorEmail} size={16} />
              <span className="muted">{formatRelative(commit.authorDate)}</span>
              <code>{shortSha(commit.sha)}</code>
              {isNew && <span className="pill small state-pending">новый</span>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
