import { useEffect, useState, type ReactNode } from 'react'
import type { DiffResult, FileState, StatusFile } from '../../../shared/types'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { DiffView } from '../components/DiffView'
import { EmptyState, Icon } from '../components/ui'
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

export function ChangesView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const status = snapshot?.status
  const files = status?.files ?? []
  const stagedFiles = files.filter((file) => file.staged)
  const unstagedFiles = files.filter((file) => file.unstaged)
  const fingerprint = files.map((file) => `${file.path}:${file.staged}:${file.unstaged}`).join('|')

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
  }, [client, selection, fingerprint])

  const doCommit = async (thenPush: boolean): Promise<void> => {
    const done = await run('Создаю коммит', async () => {
      await client.commit({ message, amend })
      if (thenPush && status?.head) await client.push(status.head)
      return true
    })
    if (done) {
      setMessage('')
      setAmend(false)
      toast('success', thenPush ? 'Коммит создан и отправлен' : 'Коммит создан')
    }
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
              Идёт операция: {status.operation}. Разреши конфликты в редакторе, добавь файлы в индекс и закоммить, либо отмени её.
              <button className="btn btn-ghost btn-small" onClick={() => void run('Отменяю операцию', () => client.abortOperation(status.operation!))}>Отменить операцию</button>
            </div>
          </div>
        )}
        <div className="file-list">
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
        {selection ? <DiffView diff={diff} /> : <EmptyState icon="changes" title={files.length ? 'Выбери файл' : 'Рабочая папка чистая'}>{files.length ? 'Его изменения появятся здесь.' : 'Незакоммиченных правок нет.'}</EmptyState>}
      </div>
    </div>
  )
}
