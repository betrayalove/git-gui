import { useEffect, useState, type ReactNode } from 'react'
import type { DiffResult } from '../../../shared/types'
import { ConfirmDialog, PromptDialog, useDialogs } from '../components/dialogs'
import { DiffView } from '../components/DiffView'
import { useDiffPreferences } from '../diff-prefs'
import { EmptyState, Icon } from '../components/ui'
import { formatRelative } from '../format'
import { useRepo } from '../store'
import { t } from '../../../shared/i18n'

export function StashView(): ReactNode {
  const { snapshot, client, run, toast } = useRepo()
  const { show } = useDialogs()
  const stashes = snapshot?.stashes ?? []
  const [sha, setSha] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const active = stashes.find((entry) => entry.sha === sha) ?? stashes[0]
  const { ignoreWhitespace } = useDiffPreferences()

  useEffect(() => {
    if (!active) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiff(null)
    client.stashDiff(active.sha, { ignoreWhitespace })
      .then((result) => { if (!cancelled) setDiff(result) })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [active, client, ignoreWhitespace])

  const newStash = (): void => show(<PromptDialog
    title={t('Сохранить правки в stash')}
    label={t('Описание')}
    placeholder={t('Что здесь сохранено')}
    confirmLabel={t('Сохранить')}
    hint={t('Правки, включая новые файлы, уйдут из рабочей папки и сохранятся в stash.')}
    onSubmit={(message) => void run(t('Сохраняю в stash'), () => client.stashPush(message, true))}
  />)

  return (
    <div className="split-view">
      <div className="split-list">
        <header className="pane-head">
          <h2>Stash</h2>
          <button className="btn btn-small" onClick={newStash}><Icon name="plus" size={13} />{t('Сохранить')}</button>
          {stashes.length > 0 && (
            <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
              title={t('Очистить stash')}
              danger
              confirmLabel={t('Удалить все: {stashesCount}', { stashesCount: stashes.length })}
              body={t('Все сохранённые записи stash будут удалены. Это нельзя отменить.')}
              onConfirm={() => void run(t('Очищаю stash'), () => client.stashClear())}
            />)}>{t('Очистить')}</button>
          )}
        </header>
        {stashes.map((entry) => (
          <button key={entry.sha} className={`list-card ${active?.sha === entry.sha ? 'active' : ''}`} onClick={() => setSha(entry.sha)}>
            <b className="truncate">{entry.message}</b>
            <span className="muted">{entry.branch ?? t('без ветки')} · {formatRelative(entry.date)}</span>
          </button>
        ))}
        {!stashes.length && <EmptyState icon="stash" title={t('Stash пуст')}>{t('Сохрани сюда незаконченные правки.')}</EmptyState>}
      </div>
      <div className="split-detail">
        {active && (
          <div className="detail-actions">
            <button className="btn btn-primary btn-small" onClick={() => void run(t('Применяю'), () => client.stashApply(active.index, false))}>{t('Применить')}</button>
            <button className="btn btn-small" onClick={() => void run(t('Применяю'), () => client.stashApply(active.index, true))}>{t('Применить и удалить')}</button>
            <button className="btn btn-small" onClick={() => show(<PromptDialog
              title={t('Ветка из stash')}
              label={t('Имя ветки')}
              confirmLabel={t('Создать')}
              onSubmit={(name) => void run(t('Создаю ветку'), async () => {
                await client.stashToBranch(name, active.index)
                toast('success', t('Создана ветка {name}', { name }))
              })}
            />)}>{t('В новую ветку')}</button>
            <button className="btn btn-small btn-ghost danger-text" onClick={() => show(<ConfirmDialog
              title={t('Удалить запись')}
              danger
              confirmLabel={t('Удалить')}
              body={<>{t('Запись «')}{active.message}{t('» будет удалена. Это нельзя отменить.')}</>}
              onConfirm={() => void run(t('Удаляю'), () => client.stashDrop(active.index))}
            />)}>{t('Удалить')}</button>
          </div>
        )}
        {active && <DiffView diff={diff} source={{ kind: 'stash', sha: active.sha }} whitespace />}
      </div>
    </div>
  )
}
