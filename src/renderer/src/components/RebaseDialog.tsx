import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RebaseRange, RewritePlan, RewritePreview, TodoAction } from '../../../shared/types'
import { formatRelative, plural, shortSha } from '../format'
import { useRepo } from '../store'
import { ReviewDialog, useDialogs } from './dialogs'
import { ResultHistory } from './ResultHistory'
import { Avatar, Icon, Modal } from './ui'

const PREVIEW_DELAY_MS = 400

const ACTIONS: { value: TodoAction; label: string }[] = [
  { value: 'pick', label: 'Оставить' },
  { value: 'squash', label: 'Объединить с предыдущим' },
  { value: 'fixup', label: 'Объединить, без сообщения' },
  { value: 'drop', label: 'Удалить' }
]

interface Step {
  sha: string
  action: TodoAction
}

/**
 * Moves a branch onto another one, with every commit editable on the way: its order, whether it
 * stays, and whether it joins the one before. The result is rebuilt as you change the list.
 */
export function RebaseDialog({ branch, initialTarget }: { branch: string; initialTarget?: string }): ReactNode {
  const { client, snapshot } = useRepo()
  const { close, show } = useDialogs()
  const refs = snapshot?.refs ?? []
  const targets = useMemo(() => [
    ...refs.filter((ref) => ref.kind === 'branch' && ref.name !== branch).map((ref) => ref.name),
    ...refs.filter((ref) => ref.kind === 'remote' && !ref.name.endsWith('/HEAD')).map((ref) => ref.name),
    ...refs.filter((ref) => ref.kind === 'tag').map((ref) => ref.name)
  ], [branch, refs])
  const defaultTarget = useMemo(() => {
    const defaults = (snapshot?.remotes ?? []).map((remote) => remote.defaultBranch).filter(Boolean) as string[]
    return defaults.find((name) => targets.includes(name)) ?? targets.find((name) => ['main', 'master', 'develop'].includes(name)) ?? targets[0] ?? ''
  }, [snapshot?.remotes, targets])
  const [target, setTarget] = useState(initialTarget ?? defaultTarget)
  const [range, setRange] = useState<RebaseRange | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<RewritePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const bySha = useMemo(() => new Map((range?.commits ?? []).map((commit) => [commit.sha, commit])), [range])

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setRange(null)
    setError(null)
    client.rebaseRange(branch, target)
      .then((result) => {
        if (cancelled) return
        setRange(result)
        setSteps(result.commits.map((commit) => ({ sha: commit.sha, action: 'pick' })))
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [branch, client, target])

  const plan = useMemo<RewritePlan | null>(() => {
    if (!range || range.upToDate || range.hasMerges || !steps.length) return null
    return {
      sequence: { base: range.base, tip: range.tip, onto: range.onto, todo: steps },
      description: `Перенос ветки ${branch} на ${target}`
    }
  }, [branch, range, steps, target])

  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!plan) return
    let cancelled = false
    const timer = setTimeout(() => {
      client.previewRewrite(plan)
        .then((result) => { if (!cancelled) setPreview(result) })
        .catch((reason: Error) => { if (!cancelled) setPreviewError(reason.message) })
    }, PREVIEW_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, plan])

  const move = (index: number, delta: number): void => {
    setSteps((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(index + delta, 0, item)
      return next
    })
  }
  const setActionAt = (index: number, action: TodoAction): void => {
    setSteps((current) => current.map((step, position) => (position === index ? { ...step, action } : step)))
  }
  const firstKept = steps.findIndex((step) => step.action !== 'drop')
  const invalid = firstKept !== -1 && steps[firstKept].action !== 'pick'
  const conflicts = preview?.conflicts.length ?? 0
  // The list shows the newest commit on top, like the history.
  const shown = steps.map((step, index) => ({ step, index })).reverse()

  return (
    <Modal
      title={`Перенести ветку ${branch}`}
      extraWide
      onClose={close}
      footer={<>
        <span className="foot-note">Репозиторий не изменится, пока ты не применишь правку. Её можно будет отменить.</span>
        <button className="btn btn-ghost" onClick={close}>Отмена</button>
        <button className="btn btn-primary" disabled={!plan || invalid || Boolean(previewError)} onClick={() => plan && show(<ReviewDialog plan={plan} />)}>
          {conflicts ? 'Разрешить конфликты' : 'Дальше'}
        </button>
      </>}
    >
      <div className="rebase-target">
        <label className="field">
          <span>Поверх чего</span>
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            {targets.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {range && !range.upToDate && (
          <p className="hint">
            {plural(range.commits.length, 'коммит', 'коммита', 'коммитов')} ветки {branch} встанут поверх {target}
            {range.base ? `, начиная от общего коммита ${shortSha(range.base)}` : ''}.
          </p>
        )}
      </div>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {range?.upToDate && <div className="banner"><Icon name="check" />Ветка {branch} уже начинается от {target}, переносить нечего.</div>}
      {range?.hasMerges && (
        <div className="banner warn"><Icon name="warning" />В ветке есть merge-коммиты. Их нельзя пересоздать точно, поэтому перенос пока недоступен. Слей ветку через merge или собери её без merge-коммитов.</div>
      )}
      {range && !range.upToDate && !range.hasMerges && (
        <div className="rebase-layout">
          <div className="rebase-steps">
            <h4>Коммиты, новые сверху</h4>
            <ol>
              {shown.map(({ step, index }) => {
                const commit = bySha.get(step.sha)!
                return (
                  <li key={step.sha} className={`rebase-step action-${step.action}`}>
                    <span className="rebase-move">
                      <button className="icon-btn" aria-label="Выше" title="Выше" disabled={index === steps.length - 1} onClick={() => move(index, 1)}><Icon name="chevron" size={12} style={{ transform: 'rotate(-90deg)' }} /></button>
                      <button className="icon-btn" aria-label="Ниже" title="Ниже" disabled={index === 0} onClick={() => move(index, -1)}><Icon name="chevron" size={12} style={{ transform: 'rotate(90deg)' }} /></button>
                    </span>
                    <Avatar name={commit.authorName} email={commit.authorEmail} size={18} />
                    <span className="rebase-subject">
                      <span className="truncate">{commit.subject}</span>
                      <span className="muted">{shortSha(commit.sha)} · {formatRelative(commit.authorDate)}</span>
                    </span>
                    <select value={step.action} aria-label={`Что сделать с «${commit.subject}»`} onChange={(event) => setActionAt(index, event.target.value as TodoAction)}>
                      {ACTIONS.map((action) => <option key={action.value} value={action.value}>{action.label}</option>)}
                    </select>
                  </li>
                )
              })}
            </ol>
            {invalid && <p className="hint danger-text">Самый нижний оставшийся коммит не с чем объединить.</p>}
          </div>
          <div className="rebase-result">
            {previewError && <div className="banner danger"><Icon name="warning" />{previewError}</div>}
            {!preview && !previewError && plan && !invalid && <div className="diff-loading">Строю результат…</div>}
            {preview && conflicts > 0 && (
              <div className="banner warn">
                <Icon name="warning" />
                Конфликт в коммите «{preview.conflicts[0].subject}». На следующем шаге можно выбрать, что должно получиться, а можно поменять порядок здесь.
              </div>
            )}
            {preview?.blockers.map((text) => <div className="banner danger" key={text}><Icon name="warning" />{text}</div>)}
            {preview?.warnings.map((text) => <div className="banner warn" key={text}><Icon name="warning" />{text}</div>)}
            {preview && !conflicts && <ResultHistory preview={preview} />}
          </div>
        </div>
      )}
    </Modal>
  )
}
