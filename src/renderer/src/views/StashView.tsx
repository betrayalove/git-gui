import { useEffect, useState, type ReactNode } from 'react'
import type { DiffResult } from '../../../shared/types'
import { ConfirmDialog, PromptDialog, useDialogs } from '../components/dialogs'
import { DiffView } from '../components/DiffView'
import { EmptyState, Icon } from '../components/ui'
import { formatRelative } from '../format'
import { useRepo } from '../store'

export function StashView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const stashes = snapshot?.stashes ?? []
  const [sha, setSha] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const active = stashes.find((entry) => entry.sha === sha) ?? stashes[0]

  useEffect(() => {
    if (!active) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiff(null)
    client.stashDiff(active.sha)
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [active, client])

  const newStash = (): void => show(<PromptDialog
    title="Сохранить правки в stash"
    label="Описание"
    placeholder="Что здесь сохранено"
    confirmLabel="Сохранить"
    hint="Правки, включая новые файлы, уйдут из рабочей папки и сохранятся в stash."
    onSubmit={(message) => void run('Сохраняю в stash', () => client.stashPush(message, true))}
  />)

  return (
    <div className="split-view">
      <div className="split-list">
        <header className="pane-head">
          <h2>Stash</h2>
          <button className="btn btn-small" onClick={newStash}><Icon name="plus" size={13} />Сохранить</button>
          {stashes.length > 0 && (
            <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
              title="Очистить stash"
              danger
              confirmLabel={`Удалить все: ${stashes.length}`}
              body="Все сохранённые записи stash будут удалены. Это нельзя отменить."
              onConfirm={() => void run('Очищаю stash', () => client.stashClear())}
            />)}>Очистить</button>
          )}
        </header>
        {stashes.map((entry) => (
          <button key={entry.sha} className={`list-card ${active?.sha === entry.sha ? 'active' : ''}`} onClick={() => setSha(entry.sha)}>
            <b className="truncate">{entry.message}</b>
            <span className="muted">{entry.branch ?? 'без ветки'} · {formatRelative(entry.date)}</span>
          </button>
        ))}
        {!stashes.length && <EmptyState icon="stash" title="Stash пуст">Сохрани сюда незаконченные правки.</EmptyState>}
      </div>
      <div className="split-detail">
        {active && (
          <div className="detail-actions">
            <button className="btn btn-primary btn-small" onClick={() => void run('Применяю', () => client.stashApply(active.index, false))}>Применить</button>
            <button className="btn btn-small" onClick={() => void run('Применяю', () => client.stashApply(active.index, true))}>Применить и удалить</button>
            <button className="btn btn-small" onClick={() => show(<PromptDialog
              title="Ветка из stash"
              label="Имя ветки"
              confirmLabel="Создать"
              onSubmit={(name) => void run('Создаю ветку', async () => {
                await client.stashToBranch(name, active.index)
                toast('success', `Создана ветка ${name}`)
              })}
            />)}>В новую ветку</button>
            <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
              title="Удалить запись"
              danger
              confirmLabel="Удалить"
              body={<>Запись «{active.message}» будет удалена. Это нельзя отменить.</>}
              onConfirm={() => void run('Удаляю', () => client.stashDrop(active.index))}
            />)}>Удалить</button>
          </div>
        )}
        {active && <DiffView diff={diff} />}
      </div>
    </div>
  )
}
