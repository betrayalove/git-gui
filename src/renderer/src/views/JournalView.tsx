import type { ReactNode } from 'react'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { EmptyState, Icon } from '../components/ui'
import { formatFull, plural } from '../format'
import { useRepo } from '../store'

export function JournalView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const entries = [...(snapshot?.journal ?? [])].reverse()
  if (!entries.length) {
    return <EmptyState icon="journal" title="Журнал пуст">Здесь появится каждая правка истории, и её можно будет отменить.</EmptyState>
  }
  return (
    <div className="schedule">
      <header className="pane-head">
        <h2>Журнал правок</h2>
        <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
          title="Удалить резервные копии"
          danger
          confirmLabel="Удалить навсегда"
          body={<>
            <p>Будут удалены журнал, резервные копии и reflog, а затем недостижимые объекты. Отменить прошлые правки станет невозможно.</p>
            <p>Это нужно, чтобы удалённые из истории данные действительно исчезли с этого компьютера. Записи stash сохранятся и могут всё ещё содержать старые версии файлов.</p>
          </>}
          onConfirm={() => void run('Удаляю резервные копии', async () => {
            await client.purgeBackups()
            toast('success', 'Резервные копии удалены')
          })}
        />)}>Удалить резервные копии</button>
      </header>
      {entries.map((entry) => (
        <article key={entry.id} className={`schedule-card ${entry.state === 'undone' ? 'is-undone' : ''}`}>
          <div className="schedule-when">
            <Icon name="journal" size={18} />
            <div>
              <b>{entry.description}</b>
              <span className="muted">{formatFull(entry.at)} · {plural(entry.updates.length, 'ссылка', 'ссылки', 'ссылок')}</span>
            </div>
            {entry.state === 'applied'
              ? <button className="btn btn-small" onClick={() => void run('Отменяю', () => client.undoEntry(entry.id))}>Отменить</button>
              : <button className="btn btn-small" onClick={() => void run('Повторяю', () => client.redoEntry(entry.id))}>Повторить</button>}
          </div>
        </article>
      ))}
    </div>
  )
}
