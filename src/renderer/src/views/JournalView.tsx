import type { ReactNode } from 'react'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { EmptyState, Icon } from '../components/ui'
import { formatFull, plural } from '../format'
import { useRepo } from '../store'
import { t, translateRecord } from '../../../shared/i18n'

export function JournalView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const entries = [...(snapshot?.journal ?? [])].reverse()
  if (!entries.length) {
    return <EmptyState icon="journal" title={t('Журнал пуст')}>{t('Здесь появится каждая правка истории, и её можно будет отменить.')}</EmptyState>
  }
  return (
    <div className="schedule">
      <header className="pane-head">
        <h2>{t('Журнал правок')}</h2>
        <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
          title={t('Удалить резервные копии')}
          danger
          confirmLabel={t('Удалить навсегда')}
          body={<>
            <p>{t('Будут удалены журнал, резервные копии и reflog, а затем недостижимые объекты. Отменить прошлые правки станет невозможно.')}</p>
            <p>{t('Это нужно, чтобы удалённые из истории данные действительно исчезли с этого компьютера. Записи stash сохранятся и могут всё ещё содержать старые версии файлов.')}</p>
          </>}
          onConfirm={() => void run(t('Удаляю резервные копии'), async () => {
            await client.purgeBackups()
            toast('success', t('Резервные копии удалены'))
          })}
        />)}>{t('Удалить резервные копии')}</button>
      </header>
      {entries.map((entry) => (
        <article key={entry.id} className={`schedule-card ${entry.state === 'undone' ? 'is-undone' : ''}`}>
          <div className="schedule-when">
            <Icon name="journal" size={18} />
            <div>
              <b>{translateRecord(entry.description)}</b>
              <span className="muted">{formatFull(entry.at)} · {plural(entry.updates.length, 'ссылка', 'ссылки', 'ссылок')}</span>
            </div>
            {entry.state === 'applied'
              ? <button className="btn btn-small" onClick={() => void run(t('Отменяю'), () => client.undoEntry(entry.id))}>{t('Отменить')}</button>
              : <button className="btn btn-small" onClick={() => void run(t('Повторяю'), () => client.redoEntry(entry.id))}>{t('Повторить')}</button>}
          </div>
        </article>
      ))}
    </div>
  )
}
