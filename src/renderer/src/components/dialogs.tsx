import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { EMPTY_DRAFT } from '../../../shared/draft'
import type { Commit, CommitEdit, ConflictResolution, DiffResult, PushPreview, SigningSetup, RewriteConflict, RewritePlan, RewritePreview } from '../../../shared/types'
import { classifyAccessError, issueSummary, type AccessIssue } from '../../../shared/access'
import { buildPatch } from '../../../shared/patch'
import { branchSettingsUrl, newRequestUrl, requestLabel } from '../../../shared/remote-url'
import { appApi } from '../api'
import { dateToLocalInput, plural, shortSha } from '../format'
import { useRepo } from '../store'
import { ConflictEditor } from './ConflictEditor'
import { DiffView } from './DiffView'
import { ResultHistory } from './ResultHistory'
import { Avatar, Icon, Modal } from './ui'
import { t } from '../../../shared/i18n'

interface DialogContextValue {
  show: (node: ReactNode) => void
  close: () => void
}

const DialogContext = createContext<DialogContextValue | null>(null)

export function useDialogs(): DialogContextValue {
  const value = useContext(DialogContext)
  if (!value) throw new Error('useDialogs used outside DialogProvider')
  return value
}

export function DialogProvider({ children }: { children: ReactNode }): ReactNode {
  const [dialog, setDialog] = useState<ReactNode>(null)
  const close = useCallback(() => setDialog(null), [])
  const value = useMemo(() => ({ show: setDialog, close }), [close])
  return (
    <DialogContext.Provider value={value}>
      {children}
      {dialog}
    </DialogContext.Provider>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm }: {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}): ReactNode {
  const { close } = useDialogs()
  return (
    <Modal
      title={title}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} autoFocus onClick={() => { close(); onConfirm() }}>{confirmLabel}</button>
      </>}
    >
      <div className="prose">{body}</div>
    </Modal>
  )
}

export function PromptDialog({ title, label, initial = '', placeholder, confirmLabel, hint, multiline, onSubmit }: {
  title: string
  label: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  hint?: ReactNode
  multiline?: boolean
  onSubmit: (value: string) => void
}): ReactNode {
  const { close } = useDialogs()
  const [value, setValue] = useState(initial)
  const submit = (): void => {
    if (!value.trim()) return
    close()
    onSubmit(value.trim())
  }
  return (
    <Modal
      title={title}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!value.trim()} onClick={submit}>{confirmLabel}</button>
      </>}
    >
      <label className="field">
        <span>{label}</span>
        {multiline
          ? <textarea autoFocus rows={4} value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} />
          : <input autoFocus value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />}
      </label>
      {hint && <p className="hint">{hint}</p>}
    </Modal>
  )
}

export function NewBranchDialog(): ReactNode {
  const { client, run } = useRepo()
  return (
    <PromptDialog
      title={t('Новая ветка')}
      label={t('Имя ветки')}
      confirmLabel={t('Создать и перейти')}
      onSubmit={(name) => void run(t('Создаю ветку'), () => client.createBranch(name, 'HEAD', true))}
    />
  )
}

export function NewStashDialog(): ReactNode {
  const { client, run } = useRepo()
  return (
    <PromptDialog
      title={t('Сохранить правки в stash')}
      label={t('Описание')}
      placeholder={t('Что здесь сохранено')}
      confirmLabel={t('Сохранить')}
      hint={t('Правки, включая новые файлы, уйдут из рабочей папки и сохранятся в stash.')}
      onSubmit={(message) => void run(t('Сохраняю в stash'), () => client.stashPush(message, true))}
    />
  )
}

export function CommitLine({ commit }: { commit: Commit }): ReactNode {
  return (
    <li className="commit-line">
      <Avatar name={commit.authorName} email={commit.authorEmail} size={18} />
      <span className="truncate">{commit.subject}</span>
      <code>{shortSha(commit.sha)}</code>
    </li>
  )
}

const MAX_WARNINGS = 6

function ConflictWalkthrough({ conflict, onDone, onBack }: {
  conflict: RewriteConflict
  onDone: (answers: Record<string, ConflictResolution>) => void
  onBack: () => void
}): ReactNode {
  const files = conflict.details ?? []
  const [active, setActive] = useState(files[0]?.path)
  const [answers, setAnswers] = useState<Record<string, ConflictResolution | null>>({})
  const file = files.find((item) => item.path === active) ?? files[0]
  const complete = files.every((item) => answers[item.path])
  return (
    <>
      <p className="prose">{t('Коммит')} <b>{conflict.subject}</b> {t('конфликтует с новым порядком. Выбери, что должно получиться.')}</p>
      {files.length > 1 && (
        <div className="conflict-tabs">
          {files.map((item) => (
            <button key={item.path} className={item.path === file?.path ? 'active' : ''} onClick={() => setActive(item.path)}>
              {answers[item.path] && <Icon name="check" size={12} />}
              {item.path}
            </button>
          ))}
        </div>
      )}
      {file && (
        <ConflictEditor
          key={file.path}
          file={file}
          oursLabel={t('История до этого коммита')}
          theirsLabel={t('Этот коммит')}
          initial={answers[file.path] ?? null}
          onChange={(resolution) => setAnswers((current) => ({ ...current, [file.path]: resolution }))}
        />
      )}
      <div className="conflict-foot">
        <button className="btn btn-ghost" onClick={onBack}>{t('Назад')}</button>
        <button
          className="btn btn-primary"
          disabled={!complete}
          onClick={() => onDone(Object.fromEntries(files.map((item) => [item.path, answers[item.path]!])))}
        >
          {t('Сохранить и продолжить')}
        </button>
      </div>
    </>
  )
}

/** Shows what a plan will do and applies it. Called for drafts and for history cleanup alike. */
export function ReviewDialog({ plan: basePlan }: { plan: RewritePlan }): ReactNode {
  const { client, setDraft, toast, run, selected, setSelected } = useRepo()
  const { close, show } = useDialogs()
  const [resolutions, setResolutions] = useState<NonNullable<RewritePlan['resolutions']>>({})
  const plan = useMemo<RewritePlan>(() => ({ ...basePlan, resolutions }), [basePlan, resolutions])
  const [signing, setSigning] = useState<SigningSetup | null>(null)
  const [resign, setResign] = useState(false)

  useEffect(() => {
    void client.signingSetup().then(setSigning).catch(() => {})
  }, [client])
  const [preview, setPreview] = useState<RewritePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [resolving, setResolving] = useState(false)
  // Bumped after a failed apply, so the preview shows the state the next attempt would use.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    setError(null)
    client.previewRewrite(plan)
      .then((result) => { if (!cancelled) setPreview(result) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [client, plan, attempt])

  const apply = async (): Promise<void> => {
    if (!preview) return
    setApplying(true)
    const result = await run(t('Применяю правки'), async () => {
      const applied = await client.applyRewrite({ ...plan, resign }, preview.refUpdates)
      // Every SHA a draft refers to may have just changed. Clearing it before the reload that
      // follows keeps that reload from mistaking this for a change made outside the app.
      setDraft(() => EMPTY_DRAFT)
      return applied
    })
    setApplying(false)
    if (!result) {
      setAttempt((value) => value + 1)
      return
    }
    close()
    const { mapping } = result.preview
    setSelected(selected.map((sha) => mapping[sha] ?? sha))
    const forced = result.preview.refUpdates.filter((update) => update.needsForcePush)
    toast('success', t('Готово. Переписано коммитов: {rewrittenCount}', { rewrittenCount: result.preview.rewrittenCount }), {
      label: t('Отменить'),
      run: () => void run(t('Отменяю'), () => client.undoEntry(result.entry.id))
    })
    if (forced.length) show(<PushDialog branch={forced[0].name} />)
  }

  const canApply = preview && !preview.conflicts.length && !preview.blockers.length && preview.refUpdates.length > 0
  const resolvable = preview?.conflicts.find((conflict) => conflict.reason === 'content' && conflict.details?.length)
  if (resolving && resolvable) {
    return (
      <Modal title={t('Разрешение конфликта')} extraWide onClose={close}>
        <ConflictWalkthrough
          key={resolvable.sha}
          conflict={resolvable}
          onBack={() => setResolving(false)}
          onDone={(answers) => {
            setResolving(false)
            setResolutions((current) => ({ ...current, [resolvable.sha]: answers }))
          }}
        />
      </Modal>
    )
  }
  return (
    <Modal
      title={t('Предпросмотр изменений')}
      wide
      onClose={close}
      footer={<>
        <span className="foot-note">{t('Сервер не изменится. Применение можно отменить.')}</span>
        <button className="btn btn-ghost" onClick={close}>{t('Назад')}</button>
        <button className="btn btn-primary" disabled={!canApply || applying} onClick={() => void apply()}>
          {applying ? t('Применяю…') : t('Применить локально')}
        </button>
      </>}
    >
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {!preview && !error && <div className="diff-loading">{t('Строю новую историю…')}</div>}
      {preview && (
        <>
          <div className="stat-row">
            <div className="stat"><b>{preview.rewrittenCount}</b><span>{t('новых SHA')}</span></div>
            <div className="stat"><b>{preview.refUpdates.filter((update) => update.kind === 'branch').length}</b><span>{t('веток изменится')}</span></div>
            <div className="stat"><b>{preview.refUpdates.filter((update) => update.kind === 'tag').length}</b><span>{t('тегов изменится')}</span></div>
            <div className="stat"><b>{preview.worktreeChanges ? t('да') : t('нет')}</b><span>{t('файлы изменятся')}</span></div>
          </div>
          {preview.conflicts.map((conflict) => (
            <div className="banner danger" key={conflict.sha}>
              <Icon name="warning" />
              <div>
                <b>
                  {conflict.reason === 'merge-commit'
                    ? t('Merge-коммит «{subject}» нельзя пересоздать точно.', { subject: conflict.subject })
                    : conflict.reason === 'split'
                      ? t('Разделение коммита «{subject}» больше не применяется.', { subject: conflict.subject })
                      : t('Конфликт в коммите «{subject}».', { subject: conflict.subject })}
                </b>
                {conflict.files.length > 0 && <div className="mono-list">{conflict.files.join(', ')}</div>}
                {conflict.reason === 'merge-commit' && <div>{t('Измени порядок так, чтобы содержимое до merge-коммита осталось прежним.')}</div>}
                {conflict.reason === 'split' && <div>{t('Отмени разделение или верни прежний порядок коммитов, затем раздели заново.')}</div>}
                {conflict.reason === 'content' && (
                  <button className="btn btn-small" onClick={() => setResolving(true)}>{t('Разрешить конфликт')}</button>
                )}
              </div>
            </div>
          ))}
          {preview.blockers.map((text) => <div className="banner danger" key={text}><Icon name="warning" />{text}</div>)}
          {preview.warnings.slice(0, MAX_WARNINGS).map((text) => <div className="banner warn" key={text}><Icon name="warning" />{text}</div>)}
          {preview.warnings.length > MAX_WARNINGS && <p className="hint">{t('И ещё предупреждений:')} {preview.warnings.length - MAX_WARNINGS}</p>}
          {preview.signaturesLost.length > 0 && signing?.available && (
            <label className="check">
              <input type="checkbox" checked={resign} onChange={(event) => setResign(event.target.checked)} />
              <span>{t('Подписать эти коммиты заново моим ключом (')}{signing.format}{t('). Подпись станет твоей, даже если раньше коммит подписывал другой человек.')}</span>
            </label>
          )}
          {preview.refUpdates.length > 0 && (
            <table className="ref-table">
              <thead><tr><th>{t('Ссылка')}</th><th>{t('Было')}</th><th>{t('Станет')}</th><th>{t('Сервер')}</th></tr></thead>
              <tbody>
                {preview.refUpdates.map((update) => (
                  <tr key={update.ref}>
                    <td><Icon name={update.kind === 'branch' ? 'branch' : 'tag'} size={13} /> {update.name}</td>
                    <td><code>{shortSha(update.beforeCommit)}</code></td>
                    <td><code className="new-sha">{shortSha(update.afterCommit)}</code></td>
                    <td>{update.needsForcePush ? <span className="pill warn">{t('нужен force-push')}</span> : <span className="pill">{t('без изменений')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.refUpdates.some((update) => update.kind === 'branch') && <ResultHistory preview={preview} />}
          {!preview.refUpdates.length && !preview.conflicts.length && !preview.blockers.length && (
            <div className="banner">{t('План ничего не меняет.')}</div>
          )}
        </>
      )}
    </Modal>
  )
}

export function PushDialog({ branch }: { branch: string }): ReactNode {
  const { client, run, toast, snapshot, showAccess } = useRepo()
  const forge = snapshot?.forge
  const { close, show } = useDialogs()
  const [preview, setPreview] = useState<PushPreview | null>(null)
  const [tags, setTags] = useState<{ name: string; expected: string }[]>([])
  const [includeTags, setIncludeTags] = useState(true)
  const [understood, setUnderstood] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    client.pushPreview(branch)
      .then(async (result) => {
        const tagList = await client.rewrittenTagsOnRemote(result.remote)
        if (!cancelled) {
          setPreview(result)
          setTags(tagList)
        }
      })
      .catch((reason: Error) => {
        if (cancelled) return
        const issue = classifyAccessError(reason.message)
        if (issue && issue !== 'offline' && forge) {
          close()
          showAccess({ issue, retry: () => show(<PushDialog branch={branch} />) })
        } else {
          setError(issue ? issueSummary(issue, forge?.host) : reason.message)
        }
      })
    return () => { cancelled = true }
    // Only a new branch or repository should repeat the check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, client])

  const send = async (): Promise<void> => {
    if (!preview) return
    close()
    const done = await run(t('Отправляю на сервер'), async () => {
      if (preview.needsForce || tags.length) {
        await client.forcePush({
          branch,
          expectedRemoteSha: preview.remoteSha,
          remote: preview.remote,
          tags: includeTags ? tags : []
        })
      } else {
        await client.push(branch, preview.remote)
      }
      return true
    })
    if (!done) return
    const requestUrl = forge?.remote === preview.remote && !preview.isDefaultBranch ? newRequestUrl(forge, preview.remoteBranch) : null
    toast('success', t('Ветка {branch} отправлена на {remote}', { branch, remote: preview.remote }), requestUrl
      ? { label: t('Создать {value}', { value: requestLabel(forge!.kind) }), run: () => void appApi.openExternal(requestUrl) }
      : undefined)
  }

  const needsConfirm = preview?.needsForce
  const protectionUrl = forge && forge.remote === preview?.remote ? branchSettingsUrl(forge) : null
  const nothing = preview && !preview.appear.length && !preview.vanish.length && !tags.length
  return (
    <Modal
      title={preview?.needsForce ? t('Перезаписать историю на сервере') : t('Отправить на сервер')}
      wide
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button
          className={`btn ${preview?.needsForce ? 'btn-danger' : 'btn-primary'}`}
          disabled={!preview || Boolean(nothing) || (needsConfirm && !understood)}
          onClick={() => void send()}
        >
          {preview?.needsForce ? t('Перезаписать на сервере') : t('Отправить')}
        </button>
      </>}
    >
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {!preview && !error && <div className="diff-loading">{t('Сверяюсь с сервером…')}</div>}
      {preview && (
        <>
          <p className="prose">
            <b>{preview.branch}</b> → <b>{preview.remote}/{preview.remoteBranch}</b>
            {!preview.remoteSha && t(' (новая ветка на сервере)')}
          </p>
          {nothing && <div className="banner">{t('На сервере уже всё актуально.')}</div>}
          {preview.remoteMoved && preview.vanish.length > 0 && (
            <div className="banner danger">
              <Icon name="warning" />
              {t('С момента последнего обновления на сервере появились новые коммиты. Посмотри список ниже: перезапись удалит их. Возможно, лучше сначала подтянуть изменения.')}
            </div>
          )}
          {preview.needsForce && preview.isDefaultBranch && (
            <div className="banner warn">
              <Icon name="warning" />
              <div>
                {t('Это основная ветка репозитория. Сервер может отклонить перезапись из-за защиты ветки.')}
                {protectionUrl && <button className="btn btn-small" onClick={() => void appApi.openExternal(protectionUrl)}><Icon name="external" size={13} />{t('Открыть настройки защиты')}</button>}
              </div>
            </div>
          )}
          <div className="push-columns">
            <div>
              <h4 className="add">{t('Появятся на сервере:')} {preview.appear.length}</h4>
              <ul className="commit-list">{preview.appear.slice(0, 100).map((commit) => <CommitLine key={commit.sha} commit={commit} />)}</ul>
            </div>
            {preview.vanish.length > 0 && (
              <div>
                <h4 className="del">{t('Исчезнут с сервера:')} {preview.vanish.length}</h4>
                <ul className="commit-list">{preview.vanish.slice(0, 100).map((commit) => <CommitLine key={commit.sha} commit={commit} />)}</ul>
              </div>
            )}
          </div>
          {tags.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={includeTags} onChange={(event) => setIncludeTags(event.target.checked)} />
              <span>{t('Также обновить теги на сервере:')} {tags.map((tag) => tag.name).join(', ')}</span>
            </label>
          )}
          {needsConfirm && (
            <>
              <p className="hint">
                {t('Участникам проекта придётся обновить свои клоны. Старые коммиты могут оставаться в их клонах, форках и открываться по прямому SHA. Отправка защищена проверкой: если сервер изменится ещё раз, git её отклонит.')}
              </p>
              <label className="check">
                <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
                <span>{t('Понимаю, что история на сервере будет перезаписана')}</span>
              </label>
            </>
          )}
        </>
      )}
    </Modal>
  )
}

export function RenameBranchDialog({ name, upstream, isDefault }: { name: string; upstream?: string; isDefault: boolean }): ReactNode {
  const { client, run, toast } = useRepo()
  const { close } = useDialogs()
  const [value, setValue] = useState(name)
  const [onRemote, setOnRemote] = useState(Boolean(upstream))
  const valid = value.trim() && value.trim() !== name

  const submit = async (): Promise<void> => {
    if (!valid) return
    close()
    const newName = value.trim()
    const result = await run(t('Переименовываю ветку'), () =>
      client.renameBranch({ oldName: name, newName, renameOnRemote: onRemote })
    )
    if (!result) return
    result.warnings.forEach((text) => toast('error', text))
    if (!result.warnings.length) {
      toast('success', result.remoteDeleted ? t('Ветка переименована локально и на сервере: {newName}', { newName }) : t('Ветка переименована: {newName}', { newName }))
    }
  }
  return (
    <Modal
      title={t('Переименовать ветку')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => void submit()}>{t('Переименовать')}</button>
      </>}
    >
      <label className="field">
        <span>{t('Новое имя')}</span>
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit() }} />
      </label>
      {upstream && (
        <label className="check">
          <input type="checkbox" checked={onRemote} onChange={(event) => setOnRemote(event.target.checked)} />
          <span>{t('Переименовать и на сервере (')}{upstream})</span>
        </label>
      )}
      {onRemote && upstream && (
        <>
          <p className="hint">{REMOTE_RENAME_NOTE}</p>
          {isDefault && <DefaultBranchRenameWarning />}
        </>
      )}
    </Modal>
  )
}

const REMOTE_RENAME_NOTE = t('На сервере создаётся новая ветка, затем удаляется старая. Открытые Pull Request и Merge Request от старой ветки могут закрыться, а у коллег старое имя останется до обновления.')

function DefaultBranchRenameWarning(): ReactNode {
  return <div className="banner warn"><Icon name="warning" />{t('Это основная ветка. Сервер не даст удалить её, пока ты не сменишь основную ветку в настройках репозитория.')}</div>
}

export function RenameRemoteBranchDialog({ remote, name }: { remote: string; name: string }): ReactNode {
  const { client, run, toast, snapshot } = useRepo()
  const { close } = useDialogs()
  const isDefault = snapshot?.remotes.find((item) => item.name === remote)?.defaultBranch === name
  const [value, setValue] = useState(name)
  const valid = value.trim() && value.trim() !== name

  const submit = (): void => {
    if (!valid) return
    close()
    const newName = value.trim()
    void run(t('Переименовываю на сервере'), async () => {
      await client.renameRemoteBranch(remote, name, newName)
      toast('success', t('Ветка на сервере переименована: {newName}', { newName }))
    })
  }
  return (
    <Modal
      title={t('Переименовать ветку на сервере')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}>{t('Переименовать')}</button>
      </>}
    >
      <label className="field">
        <span>{t('Новое имя')}</span>
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} />
      </label>
      <p className="hint">{REMOTE_RENAME_NOTE}</p>
      {isDefault && <DefaultBranchRenameWarning />}
    </Modal>
  )
}

export function ScheduleDialog({ branch, count }: { branch: string; count: number }): ReactNode {
  const { client, run, toast, commits, snapshot, setView, showAccess } = useRepo()
  const { close, show } = useDialogs()
  const [unattended, setUnattended] = useState<AccessIssue | null>(null)
  const remote = snapshot?.forge?.remote
  useEffect(() => {
    if (!remote) return
    let cancelled = false
    client.checkUnattended(remote)
      .then((result) => { if (!cancelled && !result.ok && result.issue !== 'offline') setUnattended(result.issue) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [client, remote])
  const [at, setAt] = useState(() => dateToLocalInput(new Date(Date.now() + 3600000)))
  const [dateMode, setDateMode] = useState<'keep' | 'publish-time'>('keep')
  const ref = snapshot?.refs.find((item) => item.kind === 'branch' && item.name === branch)
  const held = useMemo(() => {
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
    const list: Commit[] = []
    let current = ref ? bySha.get(ref.sha) : undefined
    while (current && list.length < count) {
      list.push(current)
      current = bySha.get(current.parents[0])
    }
    return list
  }, [commits, count, ref])
  const submit = async (): Promise<void> => {
    close()
    const entry = await run(t('Снимаю коммиты'), () =>
      client.schedulePublish({ branch, count, at: new Date(at).toISOString(), dateMode })
    )
    if (entry) {
      toast('success', t('Публикация запланирована'))
      setView('schedule')
    }
  }
  return (
    <Modal
      title={t('Снять и опубликовать позже')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!at || Date.parse(at) <= Date.now()} onClick={() => void submit()}>{t('Запланировать')}</button>
      </>}
    >
      <p className="prose">{t('Эти коммиты уйдут из ветки')} <b>{branch}</b> {t('локально и на сервере, а в указанное время вернутся.')}</p>
      {unattended && (
        <div className="banner warn">
          <Icon name="warning" />
          <div>
            {t('Без тебя сервер не примет публикацию: сейчас он отвечает только после ввода пароля или вообще не даёт доступа. Для ключа с паролем поставь галочку «Запомнить» при вводе пароля.')}
            <button className="btn btn-small" onClick={() => {
              close()
              showAccess({ issue: unattended, retry: () => show(<ScheduleDialog branch={branch} count={count} />) })
            }}><Icon name="key" size={13} />{t('Настроить доступ')}</button>
          </div>
        </div>
      )}
      <ul className="commit-list">{held.map((commit) => <CommitLine key={commit.sha} commit={commit} />)}</ul>
      <label className="field">
        <span>{t('Когда опубликовать')}</span>
        <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
      </label>
      <fieldset className="radio-group">
        <legend>{t('Даты коммитов')}</legend>
        <label className="check">
          <input type="radio" checked={dateMode === 'keep'} onChange={() => setDateMode('keep')} />
          <span>{t('Оставить как есть')}</span>
        </label>
        <label className="check">
          <input type="radio" checked={dateMode === 'publish-time'} onChange={() => setDateMode('publish-time')} />
          <span>{t('Поставить время публикации')}</span>
        </label>
      </fieldset>
      <p className="hint">
        {t('Chronicle должен быть запущен в это время, он будет ждать в трее. Если компьютер был выключен, публикация выполнится при следующем запуске. Снятые коммиты могли успеть скачать другие, и по прямому SHA они могут оставаться доступны на сервере.')}
      </p>
    </Modal>
  )
}

export function SplitCommitDialog({ commit, onConfirm }: {
  commit: Commit
  onConfirm: (split: { patch: string; message: string }, secondMessage: string) => void
}): ReactNode {
  const { client } = useRepo()
  const { close } = useDialogs()
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [firstMessage, setFirstMessage] = useState('')
  const [secondMessage, setSecondMessage] = useState(commit.message)

  useEffect(() => {
    let cancelled = false
    client.commitDiff(commit.sha)
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [client, commit.sha])

  const parts = useMemo(() => {
    const keys: string[] = []
    for (const file of diff?.files ?? []) {
      if (file.binary) continue
      if (file.hunks.length) file.hunks.forEach((_, index) => keys.push(`${file.path}\0${index}`))
      else keys.push(`${file.path}\0file`)
    }
    return keys
  }, [diff])
  const toggle = (key: string): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const box = (key: string): ReactNode => (
    <label className="split-check">
      <input type="checkbox" checked={chosen.has(key)} onChange={() => toggle(key)} />
      {t('В первый коммит')}
    </label>
  )
  const binaryCount = diff?.files.filter((file) => file.binary).length ?? 0
  const everything = chosen.size === parts.length && binaryCount === 0
  const valid = chosen.size > 0 && !everything && firstMessage.trim() && secondMessage.trim() && !diff?.truncated
  const submit = (): void => {
    const selections = (diff?.files ?? []).flatMap((file) => {
      if (chosen.has(`${file.path}\0file`)) return [{ file, hunks: [] as number[] }]
      const hunks = file.hunks.map((_, index) => index).filter((index) => chosen.has(`${file.path}\0${index}`))
      return hunks.length ? [{ file, hunks }] : []
    })
    close()
    onConfirm({ patch: buildPatch(selections), message: firstMessage.trim() }, secondMessage.trim())
  }
  return (
    <Modal
      title={t('Разделить коммит')}
      extraWide
      onClose={close}
      footer={<>
        <span className="foot-note">{t('Выбрано кусков:')} {chosen.size} {t('из')} {parts.length}{t('. Остальное попадёт во второй коммит.')}</span>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}>{t('Добавить в черновик')}</button>
      </>}
    >
      {diff?.truncated && <div className="banner warn"><Icon name="warning" />{t('Коммит слишком большой, чтобы показать его полностью, поэтому разделить его пока нельзя.')}</div>}
      {binaryCount > 0 && <div className="banner"><Icon name="warning" />{t('Бинарные файлы останутся во втором коммите.')}</div>}
      {everything && <div className="banner warn"><Icon name="warning" />{t('Оставь что-нибудь и для второго коммита.')}</div>}
      <div className="field-row">
        <label className="field">
          <span>{t('Сообщение первого коммита')}</span>
          <input autoFocus value={firstMessage} placeholder={t('Что входит в первую часть')} onChange={(event) => setFirstMessage(event.target.value)} />
        </label>
        <label className="field">
          <span>{t('Сообщение второго коммита')}</span>
          <input value={secondMessage} onChange={(event) => setSecondMessage(event.target.value)} />
        </label>
      </div>
      <DiffView
        diff={diff}
        actions={{
          hunk: (file, index) => box(`${file.path}\0${index}`),
          file: (file) => (!file.binary && !file.hunks.length ? box(`${file.path}\0file`) : null)
        }}
      />
    </Modal>
  )
}

export function ReplaceAuthorDialog(): ReactNode {
  const { commits, hasMore, setDraft } = useRepo()
  const { close } = useDialogs()
  const authors = useMemo(() => {
    const counts = new Map<string, { name: string; email: string; count: number }>()
    for (const commit of commits) {
      const key = `${commit.authorName}\0${commit.authorEmail}`
      const entry = counts.get(key) ?? { name: commit.authorName, email: commit.authorEmail, count: 0 }
      entry.count++
      counts.set(key, entry)
    }
    return [...counts.values()].sort((a, b) => b.count - a.count)
  }, [commits])
  const [source, setSource] = useState(0)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [committerToo, setCommitterToo] = useState(true)
  const from = authors[source]
  const valid = from && name.trim() && email.trim() && !/[<>\n]/.test(name + email)
  const submit = (): void => {
    if (!valid) return
    setDraft((draft) => {
      const edits = { ...draft.edits }
      for (const commit of commits) {
        if (commit.authorName !== from.name || commit.authorEmail !== from.email) continue
        const edit: CommitEdit = { ...edits[commit.sha], authorName: name.trim(), authorEmail: email.trim() }
        if (committerToo && commit.committerName === from.name && commit.committerEmail === from.email) {
          edit.committerName = name.trim()
          edit.committerEmail = email.trim()
        }
        edits[commit.sha] = edit
      }
      return { ...draft, edits }
    })
    close()
  }
  return (
    <Modal
      title={t('Заменить автора')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!valid} onClick={submit}>{t('Добавить в черновик')}</button>
      </>}
    >
      <label className="field">
        <span>{t('Кого заменить')}</span>
        <select value={source} onChange={(event) => setSource(Number(event.target.value))}>
          {authors.map((author, index) => (
            <option key={`${author.name}${author.email}`} value={index}>{author.name} &lt;{author.email}&gt;: {plural(author.count, 'коммит', 'коммита', 'коммитов')}</option>
          ))}
        </select>
      </label>
      <label className="field"><span>{t('Новое имя')}</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>{t('Новый email')}</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="check">
        <input type="checkbox" checked={committerToo} onChange={(event) => setCommitterToo(event.target.checked)} />
        <span>{t('Заменить и коммиттера, если это тот же человек')}</span>
      </label>
      {hasMore && <div className="banner warn"><Icon name="warning" />{t('Замена коснётся только загруженных коммитов. Загрузи всю историю внизу списка, чтобы охватить все.')}</div>}
    </Modal>
  )
}

export function CleanHistoryDialog(): ReactNode {
  const { commits, snapshot } = useRepo()
  const { close, show } = useDialogs()
  const [mode, setMode] = useState<'file' | 'squash'>('file')
  const [paths, setPaths] = useState('')
  const [pruneEmpty, setPruneEmpty] = useState(true)
  const [message, setMessage] = useState('Initial commit')
  const head = snapshot?.status.head
  const headSha = snapshot?.status.headSha
  const chain = useMemo(() => {
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]))
    const list: Commit[] = []
    let current = headSha ? bySha.get(headSha) : undefined
    while (current) {
      if (current.parents.length > 1) return null
      list.unshift(current)
      current = bySha.get(current.parents[0])
    }
    return list
  }, [commits, headSha])
  const pathList = paths.split('\n').map((line) => line.trim()).filter(Boolean)
  const submit = (): void => {
    if (mode === 'file') {
      show(<ReviewDialog plan={{ removePaths: pathList, pruneEmpty, description: t('Удаление из истории: {value}', { value: pathList.join(', ') }) }} />)
    } else if (chain?.length) {
      show(<ReviewDialog plan={{
        edits: { [chain[0].sha]: { message } },
        sequence: {
          base: null,
          tip: chain.at(-1)!.sha,
          todo: chain.map((commit, index) => ({ sha: commit.sha, action: index ? 'fixup' as const : 'pick' as const }))
        },
        description: t('Вся история ветки {head} собрана в один коммит', { head })
      }} />)
    }
  }
  const canSubmit = mode === 'file' ? pathList.length > 0 : Boolean(chain?.length && chain.length > 1 && message.trim())
  return (
    <Modal
      title={t('Очистка истории')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>{t('К предпросмотру')}</button>
      </>}
    >
      <div className="segmented">
        <button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>{t('Удалить файлы')}</button>
        <button className={mode === 'squash' ? 'active' : ''} onClick={() => setMode('squash')}>{t('Всё в один коммит')}</button>
      </div>
      {mode === 'file' ? (
        <>
          <label className="field">
            <span>{t('Пути от корня репозитория, по одному на строку')}</span>
            <textarea autoFocus rows={4} value={paths} placeholder={'secrets/.env\nbuild/huge.zip'} onChange={(event) => setPaths(event.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={pruneEmpty} onChange={(event) => setPruneEmpty(event.target.checked)} />
            <span>{t('Убрать коммиты, которые станут пустыми')}</span>
          </label>
          <p className="hint">{t('Файлы исчезнут из всех локальных веток и тегов. Если это утёкший пароль или ключ, его всё равно нужно отозвать: копии могли остаться у других.')}</p>
        </>
      ) : (
        <>
          {chain === null && <div className="banner warn"><Icon name="warning" />{t('В истории ветки есть merge-коммиты, поэтому объединение пока недоступно.')}</div>}
          {chain && (
            <p className="prose">
              {t('Ветка')} <b>{head}</b>: {plural(chain.length, 'коммит', 'коммита', 'коммитов')} {t('станут одним. Файлы останутся такими же, как сейчас.')}
            </p>
          )}
          <label className="field">
            <span>{t('Сообщение коммита')}</span>
            <input value={message} onChange={(event) => setMessage(event.target.value)} />
          </label>
        </>
      )}
    </Modal>
  )
}
