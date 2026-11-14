import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { CommitIdentity, WorktreeConflict } from '../../../core/ops'
import { extensionOf, folderOf, type IgnoreScope } from '../../../shared/ignore'
import { buildFilePatch, buildLinesPatch } from '../../../shared/patch'
import type { ConflictResolution, DiffResult, FileDiff, FileState, StatusFile } from '../../../shared/types'
import { ConflictEditor } from '../components/ConflictEditor'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { DiffView } from '../components/DiffView'
import { SigningDialog, signingSummary, useSigning } from '../components/Signing'
import { useDiffPreferences } from '../diff-prefs'
import { Avatar, ContextMenu, EmptyState, Icon, Modal, type MenuItem } from '../components/ui'
import { useRepo } from '../store'
import { t } from '../../../shared/i18n'

const STATE_LETTER: Record<FileState, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', conflicted: '!', untracked: 'U'
}

interface Selection {
  path: string
  staged: boolean
  untracked: boolean
}

function FileRow({ file, state, staged, active, onSelect, onToggle, onDiscard, onMenu }: {
  file: StatusFile
  state: FileState
  staged: boolean
  active: boolean
  onSelect: () => void
  onToggle: () => void
  onDiscard?: () => void
  onMenu?: (event: MouseEvent) => void
}): ReactNode {
  const slash = file.path.lastIndexOf('/')
  return (
    <div className={`file-row ${active ? 'active' : ''}`} onClick={onSelect} onContextMenu={onMenu}>
      <input
        type="checkbox"
        checked={staged}
        aria-label={staged ? t('Убрать из индекса') : t('Добавить в индекс')}
        onClick={(event) => event.stopPropagation()}
        onChange={onToggle}
      />
      <span className={`file-badge file-${state}`}>{STATE_LETTER[state]}</span>
      <span className="file-path truncate" title={file.path}>
        <b>{file.path.slice(slash + 1)}</b>
        {slash > 0 && <span className="muted"> {file.path.slice(0, slash)}</span>}
      </span>
      {onDiscard && (
        <button className="icon-btn row-action" title={t('Отменить правки')} aria-label={t('Отменить правки')} onClick={(event) => { event.stopPropagation(); onDiscard() }}>
          <Icon name="undo" size={14} />
        </button>
      )}
    </div>
  )
}

const OURS_LABEL: Record<string, string> = {
  merge: t('Текущая ветка'),
  rebase: t('Новая основа'),
  'cherry-pick': t('Текущая ветка'),
  revert: t('Текущая ветка')
}

const THEIRS_LABEL: Record<string, string> = {
  merge: t('Вливаемая ветка'),
  rebase: t('Твой коммит'),
  'cherry-pick': t('Переносимый коммит'),
  revert: t('Отменяемый коммит')
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
        oursLabel={OURS_LABEL[operation ?? ''] ?? t('Наша версия')}
        theirsLabel={THEIRS_LABEL[operation ?? ''] ?? t('Их версия')}
        initial={null}
        onChange={setAnswer}
      />
      <div className="conflict-foot">
        <button
          className="btn btn-primary"
          disabled={!answer}
          onClick={() => void run(t('Сохраняю решение'), async () => {
            await client.resolveWorktreeConflict(conflict.path, answer!)
            onResolved()
          })}
        >
          <Icon name="check" size={14} />{t('Отметить решённым')}
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
    void run(t('Сохраняю автора'), async () => {
      await client.setIdentity({ name, email })
      onSaved(await client.readIdentity())
    })
  }
  return (
    <Modal
      title={t('Автор коммитов')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!name.trim() || !email.trim()} onClick={save}>{t('Сохранить')}</button>
      </>}
    >
      <label className="field"><span>{t('Имя')}</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <p className="hint">{t('Настройка действует только в этом репозитории. Имя и email попадут в новые коммиты, а SSH-ключ на них не влияет.')}</p>
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
  const { ignoreWhitespace } = useDiffPreferences()
  useEffect(() => {
    void client.readIdentity().then(setIdentity).catch(() => {})
  }, [client])
  const editIdentity = (): void => show(<IdentityDialog initial={identity} onSaved={setIdentity} />)
  const signing = useSigning()
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
    client.worktreeDiff(selection.path, selection.staged, selection.untracked, { ignoreWhitespace })
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [client, selection, fingerprint, refreshCount, ignoreWhitespace])

  const hunkAction = (label: string, action: () => Promise<void>): void => {
    void run(label, async () => {
      await action()
      setRefreshCount((count) => count + 1)
    })
  }

  // A diff that hides whitespace no longer matches the files, so its pieces cannot be applied.
  const canApplyPieces = Boolean(selection && !selection.untracked && !ignoreWhitespace)

  const hunkControls = (file: FileDiff, index: number, lines: number[]): ReactNode => {
    if (!selection || !canApplyPieces) return null
    const some = lines.length > 0
    // Applied backwards, a patch is matched against its new side, so the other lines are kept the other way.
    const forwards = some ? buildLinesPatch(file, index, lines) : buildFilePatch(file, [index])
    const backwards = some ? buildLinesPatch(file, index, lines, true) : buildFilePatch(file, [index])
    if (selection.staged) {
      return (
        <button className="btn btn-small" onClick={() => hunkAction(some ? t('Убираю строки') : t('Убираю кусок'), () => client.applyPatch(backwards, { cached: true, reverse: true }))}>
          {some ? t('Убрать строки из индекса: {count}', { count: lines.length }) : t('Убрать из индекса')}
        </button>
      )
    }
    return (
      <>
        <button className="btn btn-small" onClick={() => hunkAction(some ? t('Добавляю строки') : t('Добавляю кусок'), () => client.applyPatch(forwards, { cached: true }))}>
          {some ? t('Строки в индекс: {count}', { count: lines.length }) : t('В индекс')}
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => show(<ConfirmDialog
          title={some ? t('Отменить выбранные строки') : t('Отменить кусок правок')}
          danger
          confirmLabel={t('Отменить правки')}
          body={t('Эти строки вернутся к версии из индекса. Это нельзя отменить.')}
          onConfirm={() => hunkAction(some ? t('Отменяю строки') : t('Отменяю кусок'), () => client.applyPatch(backwards, { reverse: true }))}
        />)}>{some ? t('Отменить строки') : t('Отменить')}</button>
      </>
    )
  }

  const doCommit = async (thenPush: boolean): Promise<void> => {
    const branch = status?.head
    const committed = await run(t('Создаю коммит'), async () => {
      await client.commit({ message, amend })
      return true
    })
    if (!committed) return
    setMessage('')
    setAmend(false)
    if (!thenPush || !branch) {
      toast('success', t('Коммит создан'))
      return
    }
    // A separate step, so that retrying after a refused connection pushes again instead of committing again.
    const pushed = await run(t('Отправляю'), async () => {
      await client.push(branch)
      return true
    })
    if (pushed) toast('success', t('Коммит создан и отправлен'))
  }

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const fileMenu = (event: MouseEvent, file: StatusFile): void => {
    event.preventDefault()
    const ignore = (scope: IgnoreScope): void => void run(t('Добавляю в .gitignore'), async () => {
      const pattern = await client.ignorePath(file.path, scope)
      toast('success', t('В .gitignore добавлено: {pattern}', { pattern }))
    })
    const extension = extensionOf(file.path)
    const folder = folderOf(file.path)
    const untracked = file.unstaged === 'untracked'
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        ...(untracked ? [
          { label: t('Игнорировать файл'), run: () => ignore('file') },
          ...(extension ? [{ label: t('Игнорировать все файлы .{extension}', { extension }), run: () => ignore('extension') }] : []),
          ...(folder ? [{ label: t('Игнорировать папку {folder}', { folder }), run: () => ignore('folder') }] : []),
          { separator: true }
        ] : []),
        { label: untracked ? t('Удалить файл…') : t('Отменить правки…'), icon: 'undo', danger: true, run: () => discard(file) }
      ]
    })
  }

  const discard = (file: StatusFile): void => {
    const untracked = file.unstaged === 'untracked'
    show(<ConfirmDialog
      title={t('Отменить правки')}
      danger
      confirmLabel={untracked ? t('Удалить файл') : t('Отменить правки')}
      body={<>{untracked ? t('Файл будет удалён') : t('Правки будут потеряны')}: <code>{file.path}</code>{t('. Это нельзя отменить.')}</>}
      onConfirm={() => void run(t('Отменяю правки'), () => client.discardFiles(untracked ? [] : [file.path], untracked ? [file.path] : []))}
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
                ? t('Идёт операция {operation}. Осталось разрешить файлов: {conflictsCount}.', { operation: status.operation, conflictsCount: conflicts.length })
                : t('Идёт операция {operation}. Конфликтов больше нет, её можно завершить.', { operation: status.operation })}
              <div className="banner-actions">
                {status.operation !== 'bisect' && (
                  <button
                    className="btn btn-primary btn-small"
                    disabled={conflicts.length > 0}
                    onClick={() => void run(t('Завершаю операцию'), () => client.continueOperation(status.operation!))}
                  >{t('Завершить')}</button>
                )}
                <button className="btn btn-ghost btn-small" onClick={() => void run(t('Отменяю операцию'), () => client.abortOperation(status.operation!))}>{t('Отменить операцию')}</button>
              </div>
            </div>
          </div>
        )}
        <div className="file-list">
          {conflicts.length > 0 && (
            <>
              <header className="list-head"><span>{t('Конфликты')}</span><span className="count">{conflicts.length}</span></header>
              {conflicts.map((conflict) => (
                <div key={conflict.path} className={`file-row ${activeConflict === conflict.path ? 'active' : ''}`} onClick={() => setActiveConflict(conflict.path)}>
                  <span className="file-badge file-conflicted">!</span>
                  <span className="file-path truncate" title={conflict.path}><b>{conflict.path}</b></span>
                </div>
              ))}
            </>
          )}
          <header className="list-head">
            <span>{t('В индексе')}</span><span className="count">{stagedFiles.length}</span>
            {stagedFiles.length > 0 && <button className="link" onClick={() => void run(t('Убираю из индекса'), () => client.unstageFiles(stagedFiles.map((file) => file.path)))}>{t('Убрать все')}</button>}
          </header>
          {stagedFiles.map((file) => (
            <FileRow
              key={`s-${file.path}`}
              file={file}
              state={file.staged!}
              staged
              active={selection?.path === file.path && selection.staged}
              onSelect={() => setSelection({ path: file.path, staged: true, untracked: false })}
              onToggle={() => void run(t('Убираю из индекса'), () => client.unstageFiles([file.path]))}
            />
          ))}
          <header className="list-head">
            <span>{t('Изменения')}</span><span className="count">{unstagedFiles.length}</span>
            {unstagedFiles.length > 0 && <button className="link" onClick={() => void run(t('Добавляю в индекс'), () => client.stageAll())}>{t('Добавить все')}</button>}
          </header>
          {unstagedFiles.map((file) => (
            <FileRow
              key={`u-${file.path}`}
              file={file}
              state={file.unstaged!}
              staged={false}
              active={selection?.path === file.path && !selection.staged}
              onSelect={() => setSelection({ path: file.path, staged: false, untracked: file.unstaged === 'untracked' })}
              onToggle={() => void run(t('Добавляю в индекс'), () => client.stageFiles([file.path]))}
              onDiscard={() => discard(file)}
              onMenu={(event) => fileMenu(event, file)}
            />
          ))}
        </div>
        <div className="commit-box">
          <button className="commit-author" title={t('Изменить для этого репозитория')} onClick={editIdentity}>
            {identity?.name && identity.email
              ? <><Avatar name={identity.name} email={identity.email} size={16} /><span className="truncate">{identity.name} &lt;{identity.email}&gt;</span></>
              : <span className="danger-text">{t('Укажи автора коммитов')}</span>}
          </button>
          {signing && (
            <button className="commit-author" title={t('Изменить для этого репозитория')} onClick={() => show(<SigningDialog />)}>
              <Icon name="shield" size={13} /><span className="truncate">{signingSummary(signing)}</span>
            </button>
          )}
          <textarea
            rows={4}
            value={message}
            placeholder={t('Сообщение коммита')}
            aria-label={t('Сообщение коммита')}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canCommit) void doCommit(false) }}
          />
          <label className="check">
            <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
            <span>{t('Дополнить последний коммит')}</span>
          </label>
          <div className="commit-actions">
            <button className="btn btn-primary" disabled={!canCommit} onClick={() => void doCommit(false)}><Icon name="check" size={14} />{t('Коммит')}</button>
            <button className="btn" disabled={!canCommit || !status?.head} onClick={() => void doCommit(true)}><Icon name="push" size={14} />{t('Коммит и пуш')}</button>
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
        ) : selection ? (
          <>
            {ignoreWhitespace && !selection.untracked && (
              <div className="banner"><Icon name="warning" />{t('Пробелы скрыты, поэтому куски и строки нельзя добавить в индекс или отменить.')}</div>
            )}
            <DiffView
              diff={diff}
              actions={{ hunk: hunkControls, lines: (file) => canApplyPieces && file.status === 'modified' && !file.binary }}
              source={{ kind: 'worktree', staged: selection.staged, untracked: selection.untracked }}
              whitespace={!selection.untracked}
            />
          </>
        ) : <EmptyState icon="changes" title={files.length ? t('Выбери файл') : t('Рабочая папка чистая')}>{files.length ? t('Его изменения появятся здесь.') : t('Незакоммиченных правок нет.')}</EmptyState>}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
