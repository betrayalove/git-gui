import { useEffect, useState, type ReactNode } from 'react'
import type { CommitIdentity, WorktreeConflict } from '../../../core/ops'
import { buildFilePatch } from '../../../shared/patch'
import type { ConflictResolution, DiffResult, FileDiff, FileState, StatusFile } from '../../../shared/types'
import { ConflictEditor } from '../components/ConflictEditor'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { DiffView } from '../components/DiffView'
import { Avatar, EmptyState, Icon, Modal } from '../components/ui'
import { useRepo } from '../store'

const STATE_LETTER: Record<FileState, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflicted: '!', untracked: 'U'
}

interface Selection {
  path: string
  staged: boolean
  untracked: boolean
}

function FileRow({ file, state, staged, active, onSelect, onToggle, onDiscard }: {
  file: StatusFile
  state: FileState
  staged: boolean
  active: boolean
  onSelect: () => void
  onToggle: () => void
  onDiscard?: () => void
}): ReactNode {
  const slash = file.path.lastIndexOf('/')
  return (
    <div className={`file-row ${active ? 'active' : ''}`} onClick={onSelect}>
      <input
        type="checkbox"
        checked={staged}
        aria-label={staged ? 'Убрать из индекса' : 'Добавить в индекс'}
        onClick={(event) => event.stopPropagation()}
        onChange={onToggle}
      />
      <span className={`file-badge file-${state}`}>{STATE_LETTER[state]}</span>
      <span className="file-path truncate" title={file.path}>
        <b>{file.path.slice(slash + 1)}</b>
        {slash > 0 && <span className="muted"> {file.path.slice(0, slash)}</span>}
      </span>
      {onDiscard && (
        <button className="icon-btn row-action" title="Отменить правки" aria-label="Отменить правки" onClick={(event) => { event.stopPropagation(); onDiscard() }}>
          <Icon name="undo" size={14} />
        </button>
      )}
    </div>
  )
}

const OURS_LABEL: Record<string, string> = {
  merge: 'Текущая ветка',
  rebase: 'Новая основа',
  'cherry-pick': 'Текущая ветка',
  revert: 'Текущая ветка'
}

const THEIRS_LABEL: Record<string, string> = {
  merge: 'Вливаемая ветка',
  rebase: 'Твой коммит',
  'cherry-pick': 'Переносимый коммит',
  revert: 'Отменяемый коммит'
}

function WorktreeConflictPane({ conflict, operation, onResolved }: {
  conflict: WorktreeConflict
  operation?: string
  onResolved: () => void
}): ReactNode {
  const { client, run } = useRepo()
  const [answer, setAnswer] = useState<ConflictResolution | null>(null)
  return (
    <div className="worktree-conflict">
      <ConflictEditor
        file={conflict}
        mergedText={conflict.mergedContent}
        oursLabel={OURS_LABEL[operation ?? ''] ?? 'Наша версия'}
        theirsLabel={THEIRS_LABEL[operation ?? ''] ?? 'Их версия'}
        initial={null}
        onChange={setAnswer}
      />
      <div className="conflict-foot">
        <button
          className="btn btn-primary"
          disabled={!answer}
          onClick={() => void run('Сохраняю решение', async () => {
            await client.resolveWorktreeConflict(conflict.path, answer!)
            onResolved()
          })}
        >
          <Icon name="check" size={14} />Отметить решённым
        </button>
      </div>
    </div>
  )
}

function IdentityDialog({ initial, onSaved }: { initial: CommitIdentity | null; onSaved: (identity: CommitIdentity) => void }): ReactNode {
  const { client, run } = useRepo()
  const { close } = useDialogs()
  const [name, setName] = useState(initial?.name ?? '')
  const [email, setEmail] = useState(initial?.email ?? '')
  const save = (): void => {
    close()
    void run('Сохраняю автора', async () => {
      await client.setIdentity({ name, email })
      onSaved(await client.readIdentity())
    })
  }
  return (
    <Modal
      title="Автор коммитов"
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>Отмена</button>
        <button className="btn btn-primary" disabled={!name.trim() || !email.trim()} onClick={save}>Сохранить</button>
      </>}
    >
      <label className="field"><span>Имя</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <p className="hint">Настройка действует только в этом репозитории. Имя и email попадут в новые коммиты, а SSH-ключ на них не влияет.</p>
    </Modal>
  )
}

export function ChangesView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [identity, setIdentity] = useState<CommitIdentity | null>(null)
  useEffect(() => {
    void client.readIdentity().then(setIdentity).catch(() => {})
  }, [client])
  const editIdentity = (): void => show(<IdentityDialog initial={identity} onSaved={setIdentity} />)
  const status = snapshot?.status
  const files = status?.files ?? []
  const stagedFiles = files.filter((file) => file.staged)
  const unstagedFiles = files.filter((file) => file.unstaged && file.unstaged !== 'conflicted')
  const fingerprint = files.map((file) => `${file.path}:${file.staged}:${file.unstaged}`).join('|')
  const [refreshCount, setRefreshCount] = useState(0)
  const [conflicts, setConflicts] = useState<WorktreeConflict[]>([])
  const [activeConflict, setActiveConflict] = useState<string | null>(null)
  const hasConflictedFiles = files.some((file) => file.unstaged === 'conflicted')

  useEffect(() => {
    if (!hasConflictedFiles) {
      setConflicts([])
      setActiveConflict(null)
      return
    }
    let cancelled = false
    client.readWorktreeConflicts()
      .then((result) => {
        if (cancelled) return
        setConflicts(result)
        setActiveConflict((current) => (result.some((item) => item.path === current) ? current : result[0]?.path ?? null))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [client, fingerprint, hasConflictedFiles])

  useEffect(() => {
    if (!selection) {
      setDiff(null)
      return
    }
    let cancelled = false
    client.worktreeDiff(selection.path, selection.staged, selection.untracked)
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [client, selection, fingerprint, refreshCount])

  const hunkAction = (label: string, action: () => Promise<void>): void => {
    void run(label, async () => {
      await action()
      setRefreshCount((count) => count + 1)
    })
  }

  const hunkControls = (file: FileDiff, index: number): ReactNode => {
    if (!selection || selection.untracked) return null
    const patch = buildFilePatch(file, [index])
    if (selection.staged) {
      return <button className="btn btn-small" onClick={() => hunkAction('Убираю кусок', () => client.applyPatch(patch, { cached: true, reverse: true }))}>Убрать из индекса</button>
    }
    return (
      <>
        <button className="btn btn-small" onClick={() => hunkAction('Добавляю кусок', () => client.applyPatch(patch, { cached: true }))}>В индекс</button>
        <button className="btn btn-small btn-ghost" onClick={() => show(<ConfirmDialog
          title="Отменить кусок правок"
          danger
          confirmLabel="Отменить правки"
          body="Эти строки вернутся к версии из индекса. Это нельзя отменить."
          onConfirm={() => hunkAction('Отменяю кусок', () => client.applyPatch(patch, { reverse: true }))}
        />)}>Отменить</button>
      </>
    )
  }

  const doCommit = async (thenPush: boolean): Promise<void> => {
    const branch = status?.head
    const committed = await run('Создаю коммит', async () => {
      await client.commit({ message, amend })
      return true
    })
    if (!committed) return
    setMessage('')
    setAmend(false)
    if (!thenPush || !branch) {
      toast('success', 'Коммит создан')
      return
    }
    // A separate step, so that retrying after a refused connection pushes again instead of committing again.
    const pushed = await run('Отправляю', async () => {
      await client.push(branch)
      return true
    })
    if (pushed) toast('success', 'Коммит создан и отправлен')
  }

  const discard = (file: StatusFile): void => {
    const untracked = file.unstaged === 'untracked'
    show(<ConfirmDialog
      title="Отменить правки"
      danger
      confirmLabel={untracked ? 'Удалить файл' : 'Отменить правки'}
      body={<>{untracked ? 'Файл будет удалён' : 'Правки будут потеряны'}: <code>{file.path}</code>. Это нельзя отменить.</>}
      onConfirm={() => void run('Отменяю правки', () => client.discardFiles(untracked ? [] : [file.path], untracked ? [file.path] : []))}
    />)
  }

  const canCommit = message.trim() && (stagedFiles.length > 0 || amend)
  return (
    <div className="changes">
      <div className="changes-side">
        {status?.operation && (
          <div className="banner warn">
            <Icon name="warning" />
            <div>
              {conflicts.length
                ? `Идёт операция ${status.operation}. Осталось разрешить файлов: ${conflicts.length}.`
                : `Идёт операция ${status.operation}. Конфликтов больше нет, её можно завершить.`}
              <div className="banner-actions">
                {status.operation !== 'bisect' && (
                  <button
                    className="btn btn-primary btn-small"
                    disabled={conflicts.length > 0}
                    onClick={() => void run('Завершаю операцию', () => client.continueOperation(status.operation!))}
                  >Завершить</button>
                )}
                <button className="btn btn-ghost btn-small" onClick={() => void run('Отменяю операцию', () => client.abortOperation(status.operation!))}>Отменить операцию</button>
              </div>
            </div>
          </div>
        )}
        <div className="file-list">
          {conflicts.length > 0 && (
            <>
              <header className="list-head"><span>Конфликты</span><span className="count">{conflicts.length}</span></header>
              {conflicts.map((conflict) => (
                <div key={conflict.path} className={`file-row ${activeConflict === conflict.path ? 'active' : ''}`} onClick={() => setActiveConflict(conflict.path)}>
                  <span className="file-badge file-conflicted">!</span>
                  <span className="file-path truncate" title={conflict.path}><b>{conflict.path}</b></span>
                </div>
              ))}
            </>
          )}
          <header className="list-head">
            <span>В индексе</span><span className="count">{stagedFiles.length}</span>
            {stagedFiles.length > 0 && <button className="link" onClick={() => void run('Убираю из индекса', () => client.unstageFiles(stagedFiles.map((file) => file.path)))}>Убрать все</button>}
          </header>
          {stagedFiles.map((file) => (
            <FileRow
              key={`s-${file.path}`}
              file={file}
              state={file.staged!}
              staged
              active={selection?.path === file.path && selection.staged}
              onSelect={() => setSelection({ path: file.path, staged: true, untracked: false })}
              onToggle={() => void run('Убираю из индекса', () => client.unstageFiles([file.path]))}
            />
          ))}
          <header className="list-head">
            <span>Изменения</span><span className="count">{unstagedFiles.length}</span>
            {unstagedFiles.length > 0 && <button className="link" onClick={() => void run('Добавляю в индекс', () => client.stageAll())}>Добавить все</button>}
          </header>
          {unstagedFiles.map((file) => (
            <FileRow
              key={`u-${file.path}`}
              file={file}
              state={file.unstaged!}
              staged={false}
              active={selection?.path === file.path && !selection.staged}
              onSelect={() => setSelection({ path: file.path, staged: false, untracked: file.unstaged === 'untracked' })}
              onToggle={() => void run('Добавляю в индекс', () => client.stageFiles([file.path]))}
              onDiscard={() => discard(file)}
            />
          ))}
        </div>
        <div className="commit-box">
          <button className="commit-author" title="Изменить для этого репозитория" onClick={editIdentity}>
            {identity?.name && identity.email
              ? <><Avatar name={identity.name} email={identity.email} size={16} /><span className="truncate">{identity.name} &lt;{identity.email}&gt;</span></>
              : <span className="danger-text">Укажи автора коммитов</span>}
          </button>
          <textarea
            rows={4}
            value={message}
            placeholder="Сообщение коммита"
            aria-label="Сообщение коммита"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canCommit) void doCommit(false) }}
          />
          <label className="check">
            <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
            <span>Дополнить последний коммит</span>
          </label>
          <div className="commit-actions">
            <button className="btn btn-primary" disabled={!canCommit} onClick={() => void doCommit(false)}><Icon name="check" size={14} />Коммит</button>
            <button className="btn" disabled={!canCommit || !status?.head} onClick={() => void doCommit(true)}><Icon name="push" size={14} />Коммит и пуш</button>
          </div>
        </div>
      </div>
      <div className="changes-diff">
        {activeConflict && conflicts.some((item) => item.path === activeConflict) ? (
          <WorktreeConflictPane
            key={activeConflict}
            conflict={conflicts.find((item) => item.path === activeConflict)!}
            operation={status?.operation}
            onResolved={() => setRefreshCount((count) => count + 1)}
          />
        ) : selection ? <DiffView diff={diff} actions={{ hunk: hunkControls }} /> : <EmptyState icon="changes" title={files.length ? 'Выбери файл' : 'Рабочая папка чистая'}>{files.length ? 'Его изменения появятся здесь.' : 'Незакоммиченных правок нет.'}</EmptyState>}
      </div>
    </div>
  )
}
