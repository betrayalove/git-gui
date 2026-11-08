import { classifyAccessError, type AccessIssue } from '../../../shared/access'
import type { ReactNode } from 'react'
import type { ScheduledPublish } from '../../../shared/types'
import { ConfirmDialog, useDialogs } from '../components/dialogs'
import { EmptyState, Icon } from '../components/ui'
import { formatFull, plural } from '../format'
import { useRepo } from '../store'
import { t, translateRecord } from '../../../shared/i18n'

const STATE_TEXT: Record<ScheduledPublish['state'], string> = {
  pending: t('Ждёт'), done: t('Опубликовано'), failed: t('Ошибка'), cancelled: t('Отменено')
}

/** A publish that ran into a refused connection stays pending and goes out once access works again. */
function accessIssueOf(error: string): AccessIssue | null {
  const issue = classifyAccessError(error)
  return issue && issue !== 'offline' && issue !== 'protected' ? issue : null
}

export function ScheduleView(): ReactNode {
  const { snapshot, client, run, toast, showAccess } = useRepo()
  const { show } = useDialogs()
  const schedules = [...(snapshot?.schedules ?? [])].sort((a, b) => {
    if ((a.state === 'pending') !== (b.state === 'pending')) return a.state === 'pending' ? -1 : 1
    return Date.parse(a.at) - Date.parse(b.at)
  })
  if (!schedules.length) {
    return (
      <EmptyState icon="schedule" title={t('Запланированных публикаций нет')}>
        {t('В истории нажми правой кнопкой на коммит и выбери «Снять и опубликовать позже».')}
      </EmptyState>
    )
  }
  return (
    <div className="schedule">
      <header className="pane-head"><h2>{t('Публикации')}</h2></header>
      {schedules.map((entry) => (
        <article key={entry.id} className={`schedule-card state-${entry.state}`}>
          <div className="schedule-when">
            <Icon name={entry.state === 'failed' ? 'warning' : 'clock'} size={18} />
            <div>
              <b>{formatFull(entry.at)}</b>
              <span className="muted">{entry.remote}/{entry.branch} · {plural(entry.commits.length, 'коммит', 'коммита', 'коммитов')} · {entry.dateMode === 'keep' ? t('даты без изменений') : t('дата публикации')}</span>
            </div>
            <span className={`pill state-${entry.state}`}>{STATE_TEXT[entry.state]}</span>
          </div>
          <ul className="schedule-commits">
            {entry.commits.map((commit) => <li key={commit.sha} className="truncate">{commit.subject}</li>)}
          </ul>
          {entry.error && <div className={`banner ${entry.state === 'failed' ? 'danger' : 'warn'}`}><Icon name="warning" />{translateRecord(entry.error)}</div>}
          {entry.note && <div className="banner">{translateRecord(entry.note)}</div>}
          {entry.error && accessIssueOf(entry.error) && snapshot?.forge && (
            <button className="btn btn-small access-action" onClick={() => showAccess({ issue: accessIssueOf(entry.error!)! })}><Icon name="key" size={13} />{t('Настроить доступ')}</button>
          )}
          <div className="detail-actions">
            {entry.state === 'pending' && (
              <button className="btn btn-primary btn-small" onClick={() => show(<ConfirmDialog
                title={t('Опубликовать сейчас')}
                confirmLabel={t('Опубликовать')}
                body={t('Коммиты будут отправлены в {remote}/{branch} прямо сейчас.', { remote: entry.remote, branch: entry.branch })}
                onConfirm={() => void run(t('Публикую'), async () => {
                  const result = await client.publishNow(entry.id)
                  toast(result.state === 'done' ? 'success' : 'error', result.state === 'done' ? t('Коммиты опубликованы') : result.error ?? t('Не удалось опубликовать'))
                })}
              />)}>{t('Опубликовать сейчас')}</button>
            )}
            {(entry.state === 'pending' || entry.state === 'failed') && (
              <button className="btn btn-small" onClick={() => void run(t('Возвращаю коммиты'), () => client.cancelSchedule(entry.id))}>{t('Отменить и вернуть в ветку')}</button>
            )}
            {entry.state !== 'pending' && entry.state !== 'failed' && (
              <button className="btn btn-small btn-ghost" onClick={() => void run(t('Убираю запись'), () => client.dismissSchedule(entry.id))}>{t('Убрать из списка')}</button>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}
