import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { applyDraftToCommits } from '../../../shared/draft'
import type { Commit, CommitEdit, DiffResult } from '../../../shared/types'
import { DiffView } from '../components/DiffView'
import { useDiffPreferences } from '../diff-prefs'
import { Avatar, EmptyState, Icon } from '../components/ui'
import { formatFull, isoToLocalInput, offsetOf, plural, shiftIso, shortSha } from '../format'
import { useRepo } from '../store'
import { t } from '../../../shared/i18n'

function splitMessage(message: string): { subject: string; body: string } {
  const [subject, ...rest] = message.split('\n')
  return { subject, body: rest.join('\n').replace(/^\n+/, '') }
}

function joinMessage(subject: string, body: string): string {
  return body.trim() ? `${subject}\n\n${body.trim()}` : subject
}

function BulkEditor({ shas }: { shas: string[] }): ReactNode {
  const { commits, setDraft } = useRepo()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [hours, setHours] = useState('')
  const [committerToo, setCommitterToo] = useState(true)
  const valid = (name.trim() && email.trim()) || (hours.trim() && !Number.isNaN(Number(hours)))
  const apply = (): void => {
    const set = new Set(shas)
    const shift = Number(hours)
    setDraft((draft) => {
      const edits = { ...draft.edits }
      for (const commit of commits) {
        if (!set.has(commit.sha)) continue
        const edit: CommitEdit = { ...edits[commit.sha] }
        if (name.trim() && email.trim()) {
          edit.authorName = name.trim()
          edit.authorEmail = email.trim()
          if (committerToo) {
            edit.committerName = name.trim()
            edit.committerEmail = email.trim()
          }
        }
        if (hours.trim() && shift) {
          edit.authorDate = shiftIso(edit.authorDate ?? commit.authorDate, shift)
          edit.committerDate = shiftIso(edit.committerDate ?? commit.committerDate, shift)
        }
        edits[commit.sha] = edit
      }
      return { ...draft, edits }
    })
    setName('')
    setEmail('')
    setHours('')
  }
  return (
    <div className="inspector-form">
      <h3>{plural(shas.length, 'коммит выбран', 'коммита выбрано', 'коммитов выбрано')}</h3>
      <label className="field"><span>{t('Новый автор')}</span><input value={name} placeholder={t('Имя')} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>{t('Email автора')}</span><input value={email} placeholder="email@example.com" onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="check">
        <input type="checkbox" checked={committerToo} onChange={(event) => setCommitterToo(event.target.checked)} />
        <span>{t('Заменить и коммиттера')}</span>
      </label>
      <label className="field"><span>{t('Сдвинуть даты, часов')}</span><input type="number" step="1" value={hours} placeholder={t('например, −24')} onChange={(event) => setHours(event.target.value)} /></label>
      <button className="btn btn-primary" disabled={!valid} onClick={apply}>{t('Добавить в черновик')}</button>
    </div>
  )
}

export function Inspector(): ReactNode {
  const { selected, commits, draft, setDraft, client, search, searchMode } = useRepo()
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [showCommitter, setShowCommitter] = useState(false)
  const sha = selected.length === 1 ? selected[0] : null
  const original: Commit | undefined = useMemo(() => commits.find((commit) => commit.sha === sha), [commits, sha])
  const shown = useMemo(() => (original ? applyDraftToCommits([original], { edits: draft.edits, sequence: null })[0] : undefined), [draft.edits, original])
  const { ignoreWhitespace } = useDiffPreferences()

  useEffect(() => {
    if (!sha) return
    let cancelled = false
    setDiff(null)
    client.commitDiff(sha, { ignoreWhitespace })
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [client, sha, ignoreWhitespace])

  if (selected.length > 1) return <aside className="inspector"><BulkEditor shas={selected} /></aside>
  if (!original || !shown) {
    return <aside className="inspector"><EmptyState icon="history" title={t('Выбери коммит')}>{t('Здесь можно изменить его сообщение, автора и даты. Выбери несколько с Cmd или Shift, чтобы править их вместе.')}</EmptyState></aside>
  }

  const update = (field: keyof CommitEdit, value: string): void => {
    setDraft((current) => {
      const edit: CommitEdit = { ...current.edits[original.sha] }
      const unchanged = field === 'message'
        ? value.replace(/\s+$/, '') === original.message
        : value === original[field]
      if (unchanged) delete edit[field]
      else edit[field] = value
      return { ...current, edits: { ...current.edits, [original.sha]: edit } }
    })
  }
  const edit = draft.edits[original.sha] ?? {}
  const { subject, body } = splitMessage(edit.message ?? shown.message)
  const dateInput = (field: 'authorDate' | 'committerDate'): ReactNode => (
    <input
      type="datetime-local"
      step="1"
      value={isoToLocalInput(shown[field])}
      onChange={(event) => {
        if (!event.target.value) return
        const value = event.target.value.length === 16 ? `${event.target.value}:00` : event.target.value
        update(field, `${value}${offsetOf(original[field])}`)
      }}
    />
  )
  const reset = (): void => {
    setDraft((current) => {
      const edits = { ...current.edits }
      delete edits[original.sha]
      return { ...current, edits }
    })
  }

  return (
    <aside className="inspector">
      <div className="inspector-form">
        <div className="inspector-head">
          <Avatar name={shown.authorName} email={shown.authorEmail} size={32} />
          <div className="truncate">
            <code title={original.sha}>{shortSha(original.sha)}</code>
            <div className="muted">{formatFull(shown.authorDate)}</div>
          </div>
          {draft.edits[original.sha] && Object.keys(draft.edits[original.sha]).length > 0 && (
            <button className="btn btn-ghost btn-small" onClick={reset}><Icon name="undo" size={13} />{t('Сбросить')}</button>
          )}
        </div>
        <label className={`field ${edit.message !== undefined ? 'edited' : ''}`}>
          <span>{t('Заголовок')}</span>
          <input value={subject} onChange={(event) => update('message', joinMessage(event.target.value, body))} />
        </label>
        <label className={`field ${edit.message !== undefined ? 'edited' : ''}`}>
          <span>{t('Описание')}</span>
          <textarea rows={4} value={body} placeholder={t('Подробности изменения')} onChange={(event) => update('message', joinMessage(subject, event.target.value))} />
        </label>
        <div className="field-row">
          <label className={`field ${edit.authorName !== undefined ? 'edited' : ''}`}>
            <span>{t('Автор')}</span>
            <input value={shown.authorName} onChange={(event) => update('authorName', event.target.value)} />
          </label>
          <label className={`field ${edit.authorEmail !== undefined ? 'edited' : ''}`}>
            <span>Email</span>
            <input value={shown.authorEmail} onChange={(event) => update('authorEmail', event.target.value)} />
          </label>
        </div>
        <label className={`field ${edit.authorDate !== undefined ? 'edited' : ''}`}>
          <span>{t('Дата автора (')}{offsetOf(original.authorDate)})</span>
          {dateInput('authorDate')}
        </label>
        <button className="disclosure" onClick={() => setShowCommitter(!showCommitter)} aria-expanded={showCommitter}>
          <Icon name="chevron" size={12} style={{ transform: showCommitter ? 'rotate(90deg)' : undefined }} />
          {t('Коммиттер')}
        </button>
        {showCommitter && (
          <>
            <div className="field-row">
              <label className={`field ${edit.committerName !== undefined ? 'edited' : ''}`}>
                <span>{t('Имя')}</span>
                <input value={shown.committerName} onChange={(event) => update('committerName', event.target.value)} />
              </label>
              <label className={`field ${edit.committerEmail !== undefined ? 'edited' : ''}`}>
                <span>Email</span>
                <input value={shown.committerEmail} onChange={(event) => update('committerEmail', event.target.value)} />
              </label>
            </div>
            <label className={`field ${edit.committerDate !== undefined ? 'edited' : ''}`}>
              <span>{t('Дата коммита (')}{offsetOf(original.committerDate)})</span>
              {dateInput('committerDate')}
            </label>
          </>
        )}
      </div>
      <div className="inspector-diff"><DiffView key={sha} diff={diff} highlight={searchMode === 'content' ? search.trim() : undefined} collapsed source={{ kind: 'commit', sha: original.sha }} whitespace /></div>
    </aside>
  )
}
