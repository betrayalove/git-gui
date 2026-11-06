import type { ReactNode } from 'react'
import type { ScheduledPublish } from '../../../shared/types'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { EmptyState, Icon } from '../components/ui'
import { formatFull, plural } from '../format'
import { useRepo } from '../store'

const STATE_TEXT: Record<ScheduledPublish['state'], string> = {
  pending: 'Ждёт', done: 'Опубликовано', failed: 'Ошибка', cancelled: 'Отменено'
}

export function ScheduleView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const schedules = [...(snapshot?.schedules ?? [])].sort((a, b) => {
    if ((a.state === 'pending') !== (b.state === 'pending')) return a.state === 'pending' ? -1 : 1
    return Date.parse(a.at) - Date.parse(b.at)
  })
  if (!schedules.length) {
    return (
      <EmptyState icon="schedule" title="Запланированных публикаций нет">
        В истории нажми правой кнопкой на коммит и выбери «Снять и опубликовать позже».
      </EmptyState>
    )
  }
  return (
    <div className="schedule">
      <header className="pane-head"><h2>Публикации</h2></header>
      {schedules.map((entry) => (
        <article key={entry.id} className={`schedule-card state-${entry.state}`}>
          <div className="schedule-when">
            <Icon name={entry.state === 'failed' ? 'warning' : 'clock'} size={18} />
            <div>
              <b>{formatFull(entry.at)}</b>
              <span className="muted">{entry.remote}/{entry.branch} · {plural(entry.commits.length, 'коммит', 'коммита', 'коммитов')} · {entry.dateMode === 'keep' ? 'даты без изменений' : 'дата публикации'}</span>
            </div>
            <span className={`pill state-${entry.state}`}>{STATE_TEXT[entry.state]}</span>
          </div>
          <ul className="schedule-commits">
            {entry.commits.map((commit) => <li key={commit.sha} className="truncate">{commit.subject}</li>)}
          </ul>
          {entry.error && <div className={`banner ${entry.state === 'failed' ? 'danger' : 'warn'}`}><Icon name="warning" />{entry.error}</div>}
          {entry.note && <div className="banner">{entry.note}</div>}
          <div className="detail-actions">
            {entry.state === 'pending' && (
              <button className="btn btn-primary btn-small" onClick={() => show(<ConfirmDialog
                title="Опубликовать сейчас"
                confirmLabel="Опубликовать"
                body={`Коммиты будут отправлены в ${entry.remote}/${entry.branch} прямо сейчас.`}
                onConfirm={() => void run('Публикую', async () => {
                  const result = await client.publishNow(entry.id)
                  toast(result.state === 'done' ? 'success' : 'error', result.state === 'done' ? 'Коммиты опубликованы' : result.error ?? 'Не удалось опубликовать')
                })}
              />)}>Опубликовать сейчас</button>
            )}
            {(entry.state === 'pending' || entry.state === 'failed') && (
              <button className="btn btn-small" onClick={() => void run('Возвращаю коммиты', () => client.cancelSchedule(entry.id))}>Отменить и вернуть в ветку</button>
            )}
            {entry.state !== 'pending' && entry.state !== 'failed' && (
              <button className="btn btn-small btn-ghost" onClick={() => void run('Убираю запись', () => client.dismissSchedule(entry.id))}>Убрать из списка</button>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}
