import { useEffect, useState, type ReactNode } from 'react'
import { requestLabel, requestsPageUrl } from '../../../shared/remote-url'
import type { CheckState, ForgeRequest } from '../../../shared/types'
import { appApi } from '../api'
import { useDialogs } from '../components/dialogs'
import { EmptyState, Icon, Modal } from '../components/ui'
import { useForgeAccounts } from '../forge-accounts'
import { formatRelative } from '../format'
import { useRepo } from '../store'
import { SettingsDialog } from './SettingsDialog'
import { t } from '../../../shared/i18n'

const CHECKS: Record<CheckState, { label: string; tone: string }> = {
  success: { label: t('Проверки прошли'), tone: 'good' },
  failure: { label: t('Проверки упали'), tone: 'bad' },
  pending: { label: t('Проверки идут'), tone: 'pending' },
  none: { label: t('Проверок нет'), tone: 'none' }
}

/** Opens a Pull or Merge Request from a branch, pushing the branch first when the server lacks it. */
export function CreateRequestDialog({ branch, onCreated }: { branch?: string; onCreated?: () => void }): ReactNode {
  const { snapshot, commits, client, run, toast } = useRepo()
  const { close } = useDialogs()
  const forge = snapshot?.forge
  const label = requestLabel(forge?.kind ?? null)
  const branches = (snapshot?.refs ?? []).filter((ref) => ref.kind === 'branch')
  const remote = forge?.remote ?? 'origin'
  const remoteBranches = (snapshot?.refs ?? [])
    .filter((ref) => ref.kind === 'remote' && ref.name.startsWith(`${remote}/`) && !ref.name.endsWith('/HEAD'))
    .map((ref) => ref.name.slice(remote.length + 1))
  const defaultTarget = snapshot?.remotes.find((item) => item.name === remote)?.defaultBranch ?? remoteBranches.find((name) => name === 'main' || name === 'master') ?? ''
  const [source, setSource] = useState(branch ?? snapshot?.status.head ?? '')
  const [target, setTarget] = useState(defaultTarget)
  const tipSubject = (name: string): string => {
    const tip = branches.find((ref) => ref.name === name)?.sha
    return commits.find((commit) => commit.sha === tip)?.subject ?? ''
  }
  const [title, setTitle] = useState(tipSubject(source))
  const [description, setDescription] = useState('')
  const [draft, setDraft] = useState(false)
  const sourceRef = branches.find((ref) => ref.name === source)
  // The server can only open a request for commits it has.
  const needsPush = !sourceRef?.upstream || Boolean(sourceRef.ahead) || Boolean(sourceRef.upstreamGone)

  const submit = (): void => {
    close()
    void run(t('Создаю {label}', { label }), async () => {
      if (needsPush) await client.push(source)
      const url = await client.createRequest({ sourceBranch: source, targetBranch: target, title, description, draft })
      toast('success', t('{label} создан', { label }), { label: t('Открыть'), run: () => void appApi.openExternal(url) })
      onCreated?.()
    })
  }

  return (
    <Modal
      title={t('Новый {label}', { label })}
      onClose={close}
      wide
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!source || !target || source === target || !title.trim()} onClick={submit}>
          {needsPush ? t('Отправить ветку и создать') : t('Создать')}
        </button>
      </>}
    >
      <div className="field-row">
        <label className="field">
          <span>{t('Из ветки')}</span>
          <select value={source} onChange={(event) => { setSource(event.target.value); setTitle(tipSubject(event.target.value)) }}>
            {branches.map((ref) => <option key={ref.name} value={ref.name}>{ref.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('В ветку')}</span>
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            {!target && <option value="">{t('Выбери ветку')}</option>}
            {remoteBranches.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>
      <label className="field">
        <span>{t('Заголовок')}</span>
        <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="field">
        <span>{t('Описание')}</span>
        <textarea rows={6} value={description} placeholder={t('Что изменилось и зачем')} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
        <span>{t('Черновик: пока не готов к проверке')}</span>
      </label>
      {needsPush && source && <p className="hint">{t('Ветки {branch} нет на сервере или в ней есть новые коммиты, поэтому сначала она будет отправлена на {remote}.', { branch: source, remote })}</p>}
    </Modal>
  )
}

function RequestRow({ request }: { request: ForgeRequest }): ReactNode {
  const { client, run, toast } = useRepo()
  const checks = CHECKS[request.checks]
  return (
    <div className="request-row">
      <span className={`check-dot check-${checks.tone}`} title={checks.label} aria-label={checks.label} />
      <div className="request-main">
        <div className="request-title">
          <b className="truncate">{request.title}</b>
          {request.draft && <span className="pill small">{t('Черновик')}</span>}
        </div>
        <div className="muted truncate">
          #{request.number} · {request.author} · {request.sourceBranch} → {request.targetBranch} · {formatRelative(request.updatedAt)}
        </div>
      </div>
      <div className="request-actions">
        <button className="btn btn-small" onClick={() => void run(t('Переключаюсь'), async () => {
          const branch = await client.checkoutRequest({ number: request.number, sourceBranch: request.sourceBranch, fromFork: request.fromFork })
          toast('success', t('Ветка {branch}', { branch }))
        })}>{t('Перейти на ветку')}</button>
        <button className="btn btn-small btn-ghost" onClick={() => void appApi.openExternal(request.url)}><Icon name="external" size={13} />{t('На сайте')}</button>
      </div>
    </div>
  )
}

export function RequestsView(): ReactNode {
  const { snapshot, client } = useRepo()
  const { show, close } = useDialogs()
  const accounts = useForgeAccounts()
  const forge = snapshot?.forge
  const account = forge && accounts?.find((item) => item.host === forge.host)
  const label = requestLabel(forge?.kind ?? null)
  const [requests, setRequests] = useState<ForgeRequest[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!account) return
    let cancelled = false
    setError(null)
    client.listRequests()
      .then((result) => { if (!cancelled) setRequests(result ?? []) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [account, client, version])

  const openSettings = (): void => show(<SettingsDialog onClose={close} forgeHost={forge?.host} />)
  const site = forge ? requestsPageUrl(forge) : null

  if (!forge) {
    return <div className="requests"><EmptyState icon="external" title={t('Нет remote')}>{t('Добавь remote на GitHub или GitLab, и здесь появятся Pull Request и Merge Request.')}</EmptyState></div>
  }
  if (!account) {
    return (
      <div className="requests">
        <EmptyState icon="external" title={forge.kind ? t('{label} прямо в приложении', { label }) : t('GitHub это или GitLab?')}>
          <p>{forge.kind
            ? t('Добавь токен для {host} в настройках. Тогда здесь будут открытые {label} со статусом проверок, и их можно будет создавать.', { host: forge.host, label })
            : t('По имени {host} не понять, какой это сервер. Добавь для него токен в настройках и выбери тип.', { host: forge.host })}</p>
          <div className="inline-actions centered">
            <button className="btn btn-primary" onClick={openSettings}><Icon name="key" size={14} />{t('Добавить токен')}</button>
            {site && <button className="btn" onClick={() => void appApi.openExternal(site)}><Icon name="external" size={14} />{t('Открыть на сайте')}</button>}
          </div>
        </EmptyState>
      </div>
    )
  }
  return (
    <div className="requests">
      <header className="pane-head">
        <h2>{t('Открытые {label}', { label })}</h2>
        <span className="muted">{account.account} · {forge.host}</span>
        <button className="btn btn-small btn-ghost" onClick={() => { setRequests(null); setVersion((value) => value + 1) }}>{t('Обновить')}</button>
        <button className="btn btn-small btn-primary" onClick={() => show(<CreateRequestDialog onCreated={() => setVersion((value) => value + 1)} />)}>
          <Icon name="plus" size={13} />{t('Создать')}
        </button>
      </header>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {!error && !requests && <div className="diff-loading">{t('Загружаю список…')}</div>}
      {requests?.length === 0 && <EmptyState icon="check" title={t('Открытых {label} нет', { label })} />}
      <div className="request-list">
        {requests?.map((request) => <RequestRow key={request.number} request={request} />)}
      </div>
    </div>
  )
}
