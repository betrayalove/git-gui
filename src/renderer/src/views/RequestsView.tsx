import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ForgeRequest } from '../../../shared/types'
import { appApi } from '../api'
import { NewRequestDialog, useDialogs } from '../components/dialogs'
import { EmptyState, Icon } from '../components/ui'
import { formatRelative } from '../format'
import { useRepo } from '../store'
import { SettingsDialog } from './SettingsDialog'

export function RequestsView(): ReactNode {
  const { snapshot, client, reload } = useRepo()
  const { show, close } = useDialogs()
  const forge = snapshot?.forge
  const hasAccount = Boolean(forge?.account)
  const [requests, setRequests] = useState<ForgeRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const label = forge?.kind === 'gitlab' ? 'Merge Request' : 'Pull Request'
  const prefix = forge?.kind === 'gitlab' ? '!' : '#'
  const defaultBranch = snapshot?.remotes.find((remote) => remote.name === forge?.remote)?.defaultBranch ?? 'main'

  const load = useCallback(() => {
    if (!hasAccount) return
    setError(null)
    client.forgeListRequests(forge?.remote)
      .then(setRequests)
      .catch((reason: Error) => setError(reason.message))
  }, [client, forge?.remote, hasAccount])
  useEffect(load, [load])

  const settings = (
    <button className="btn btn-primary" onClick={() => show(<SettingsDialog onClose={close} onChanged={() => void reload()} />)}>Подключить аккаунт</button>
  )
  if (!forge) {
    return (
      <div className="schedule">
        <EmptyState icon="merge" title="Сервер не распознан">
          GitHub и GitLab определяются по адресу remote. Для своего сервера подключи аккаунт с его адресом.
        </EmptyState>
        <div className="load-more">{settings}</div>
      </div>
    )
  }
  const webPath = forge.kind === 'gitlab' ? '/-/merge_requests' : '/pulls'
  return (
    <div className="requests">
      <header className="pane-head">
        <h2>{label}</h2>
        {forge.webUrl.startsWith('https://') && (
          <button className="btn btn-small btn-ghost" onClick={() => void appApi.openExternal(`${forge.webUrl}${webPath}`)}><Icon name="external" size={13} />На сайте</button>
        )}
        {hasAccount && <button className="btn btn-small btn-ghost" onClick={load}>Обновить</button>}
        {hasAccount && (
          <button className="btn btn-small" onClick={() => show(<NewRequestDialog source={snapshot?.status.head ?? ''} target={defaultBranch} label={label} onCreated={load} />)}><Icon name="plus" size={13} />Новый</button>
        )}
      </header>
      {!hasAccount && (
        <>
          <EmptyState icon="merge" title={`Аккаунт ${forge.host} не подключён`}>Подключи его, чтобы видеть и создавать запросы прямо здесь.</EmptyState>
          <div className="load-more">{settings}</div>
        </>
      )}
      {error && <div className="banner danger request-error"><Icon name="warning" />{error}</div>}
      {hasAccount && !requests && !error && <div className="diff-loading">Загружаю запросы…</div>}
      {requests?.length === 0 && <EmptyState icon="merge" title="Открытых запросов нет" />}
      {requests?.map((request) => (
        <button
          key={request.number}
          className={`request-row ${request.draft ? 'draft' : ''}`}
          title="Открыть на сайте"
          onClick={() => void appApi.openExternal(request.url)}
        >
          <Icon name="merge" />
          <span className="request-main">
            <b className="truncate">{request.title}</b>
            <span className="muted">{prefix}{request.number} · {request.author} · {formatRelative(request.updatedAt)}{request.draft ? ' · черновик' : ''}</span>
          </span>
          <span className="request-branches">{request.sourceBranch} → {request.targetBranch}</span>
        </button>
      ))}
    </div>
  )
}
