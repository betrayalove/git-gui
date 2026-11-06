import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HostProbe, KeyStatus, SshKey } from '../../../core/ssh'
import { issueSummary, sshKeysPage, targetFromUrl, toSshUrl, type AccessIssue, type SshTarget } from '../../../shared/access'
import { kindForHost, parseRemoteUrl } from '../../../shared/remote-url'
import type { ForgeKind } from '../../../shared/types'
import { appApi, repoClient } from '../api'
import { Icon, Modal } from './ui'

export interface AccessResult {
  /** A key the failed action has to use. Null when ssh finds the right one by itself. */
  keyPath: string | null
  /** The address to use from now on, when it changed. */
  url: string | null
}

const FORGE_NAME: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' }
const STANDARD_HOST: Record<ForgeKind, string> = { github: 'github.com', gitlab: 'gitlab.com' }

const ADD_STEPS: Record<ForgeKind, string[]> = {
  github: [
    'Нажми кнопку выше: ключ скопируется, и откроется страница GitHub. Если сайт попросит войти, войди как обычно.',
    'В поле Title напиши любое название, например имя компьютера. Key type оставь Authentication Key.',
    'Вставь ключ в поле Key и нажми Add SSH key.',
    'Вернись сюда: приложение проверит подключение само.'
  ],
  gitlab: [
    'Нажми кнопку выше: ключ скопируется, и откроется страница GitLab. Если сайт попросит войти, войди как обычно.',
    'Нажми Add new key и вставь ключ в поле Key.',
    'Title заполнится сам, а Usage type оставь Authentication & Signing. Срок действия можно убрать.',
    'Нажми Add key и вернись сюда: приложение проверит подключение само.'
  ]
}

const PROBE_TEXT: Record<Exclude<HostProbe, 'reachable'>, string> = {
  rejected: 'Подключение не подтверждено. Без этого сервер использовать нельзя.',
  changed: 'Ключ сервера не совпадает с тем, что этот компьютер видел раньше. Возможно, сервер сменил ключи, а возможно, соединение кто-то перехватывает. Сверь отпечаток на сайте сервера. Если всё верно, убери старую запись командой ssh-keygen -R с адресом сервера.',
  offline: 'Сервер недоступен. Проверь интернет и адрес сервера: ключи здесь ни при чём.',
  'no-ssh': 'На компьютере не найден ssh. Установи Git или OpenSSH и повтори.'
}

type Stage =
  | { name: 'checking'; text: string }
  | { name: 'blocked'; probe: Exclude<HostProbe, 'reachable'> }
  | { name: 'create' }
  | { name: 'add' }
  | { name: 'no-access'; account: string | null; message: string }
  | { name: 'done'; account: string | null; result: AccessResult }

function statusPill(status: KeyStatus | undefined): ReactNode {
  if (!status) return <span className="pill small">проверяю…</span>
  if (status.state === 'connected') return <span className="pill small state-done">{status.account ? `подключён как ${status.account}` : 'подключён'}</span>
  if (status.state === 'locked') return <span className="pill small state-pending">нужен пароль</span>
  if (status.state === 'rejected') return <span className="pill small">не добавлен на сервер</span>
  if (status.state === 'unknown') return <span className="pill small state-pending">нужен пароль</span>
  return <span className="pill small state-failed">не проверен</span>
}

function CreateKeyForm({ onCreated, onBack }: { onCreated: (path: string) => void; onBack?: () => void }): ReactNode {
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [remember, setRemember] = useState(false)
  const [canRemember, setCanRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void appApi.savedPassphrases().then((saved) => setCanRemember(saved.available))
  }, [])
  const tooShort = passphrase.length > 0 && passphrase.length < 5
  const mismatch = passphrase !== repeat
  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      onCreated(await appApi.sshCreateKey(passphrase, remember))
    } catch (reason) {
      setError((reason as Error).message)
      setBusy(false)
    }
  }
  return (
    <>
      <p className="prose">На этом компьютере нет подходящего SSH-ключа. Создадим новый: приватная часть останется здесь, а на сайт попадёт только публичная.</p>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      <div className="field-row">
        <label className="field">
          <span>Пароль ключа, необязательно</span>
          <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        </label>
        <label className="field">
          <span>Ещё раз</span>
          <input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
        </label>
      </div>
      {tooShort && <p className="hint danger-text">Нужно не меньше 5 символов.</p>}
      {!tooShort && mismatch && repeat && <p className="hint danger-text">Пароли не совпадают.</p>}
      {passphrase && canRemember && (
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>Запомнить на этом компьютере. Пароль будет зашифрован средствами системы, и отложенные публикации смогут выходить без тебя.</span>
        </label>
      )}
      <p className="hint">Пароль защитит ключ, если файл попадёт к кому-то ещё. Восстановить забытый пароль нельзя, но можно создать новый ключ.</p>
      <div className="inline-actions access-actions">
        <button className="btn btn-primary" disabled={busy || tooShort || mismatch} onClick={() => void create()}><Icon name="key" size={14} />{busy ? 'Создаю…' : 'Создать ключ'}</button>
        {onBack && <button className="btn btn-ghost" onClick={onBack}>Назад</button>}
      </div>
    </>
  )
}

/**
 * Connects this computer to a server with an SSH key and no account: it uses a key that already
 * works, asks for a key's password, or creates a key and explains how to add it on the site.
 */
export function AccessDialog({ url, repoPath, remote, issue, onClose, onRetry }: {
  url?: string
  repoPath?: string
  remote?: string
  issue?: AccessIssue
  onClose: () => void
  onRetry?: (result: AccessResult) => void
}): ReactNode {
  const parsed = useMemo(() => (url ? parseRemoteUrl(url) : null), [url])
  const sshUrl = url ? (parsed?.protocol === 'ssh' ? url : toSshUrl(url)) : null
  const switchesToSsh = Boolean(url && sshUrl && sshUrl !== url)
  const known = parsed ? kindForHost(parsed.host) : null
  const [provider, setProvider] = useState<ForgeKind>(known ?? 'github')
  const [hostInput, setHostInput] = useState(known ? '' : STANDARD_HOST.github)
  const [freeHost, setFreeHost] = useState(STANDARD_HOST.github)
  const target = useMemo<SshTarget | null>(
    () => (url ? targetFromUrl(url) : { host: freeHost, user: 'git' }),
    [freeHost, url]
  )
  const webHost = parsed && parsed.protocol !== 'ssh' ? parsed.host : target?.host ?? ''
  const [stage, setStage] = useState<Stage>({ name: 'checking', text: 'Проверяю сервер…' })
  const [keys, setKeys] = useState<SshKey[]>([])
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [opened, setOpened] = useState(false)
  const generation = useRef(0)
  const selected = keys.find((key) => key.id === selectedId) ?? keys[0] ?? null

  const finish = useCallback(async (key: SshKey, account: string | null, run: number): Promise<void> => {
    if (!sshUrl) {
      setStage({ name: 'done', account, result: { keyPath: null, url: null } })
      return
    }
    setStage({ name: 'checking', text: 'Проверяю доступ к репозитории…' })
    const repoArg = repoPath ?? null
    const plain = await appApi.sshCheckRemote(repoArg, sshUrl)
    if (run !== generation.current) return
    const newUrl = switchesToSsh ? sshUrl : null
    if (plain.ok) {
      setStage({ name: 'done', account, result: { keyPath: null, url: newUrl } })
      return
    }
    // ssh picked another key on its own, or none. Trying this one saves nothing yet.
    const direct = key.path ? await appApi.sshCheckRemote(repoArg, sshUrl, key.path) : plain
    if (run !== generation.current) return
    if (!direct.ok) {
      setStage({ name: 'no-access', account, message: direct.message })
      return
    }
    if (repoPath) await repoClient(repoPath).useKeyForRepo(key)
    setStage({ name: 'done', account, result: { keyPath: key.path, url: newUrl } })
  }, [repoPath, sshUrl, switchesToSsh])

  /** Asks for the key's password through the usual dialog, then continues if the key connects. */
  const unlock = useCallback(async (key: SshKey, run: number): Promise<KeyStatus> => {
    const status = await appApi.sshCheckKey(key, target!, true)
    if (run !== generation.current) return status
    setStatuses((current) => ({ ...current, [key.id]: status }))
    if (status.state === 'connected') await finish(key, status.account, run)
    return status
  }, [finish, target])

  const scan = useCallback(async (preferPath?: string): Promise<void> => {
    if (!target) return
    const run = ++generation.current
    setNote(null)
    setStage({ name: 'checking', text: 'Проверяю сервер…' })
    const probe = await appApi.sshProbeHost(target)
    if (run !== generation.current) return
    if (probe !== 'reachable') {
      setStage({ name: 'blocked', probe })
      return
    }
    setStage({ name: 'checking', text: 'Ищу ключи на этом компьютере…' })
    const list = await appApi.sshListKeys(target.host)
    if (run !== generation.current) return
    setKeys(list)
    setStatuses({})
    const found: Record<string, KeyStatus> = {}
    for (const key of list) {
      const status = await appApi.sshCheckKey(key, target)
      if (run !== generation.current) return
      found[key.id] = status
      setStatuses((current) => ({ ...current, [key.id]: status }))
      if (status.state === 'connected') {
        setSelectedId(key.id)
        await finish(key, status.account, run)
        return
      }
    }
    const lockedKey = list.find((key) => found[key.id].state === 'locked')
    if (lockedKey) {
      setSelectedId(lockedKey.id)
      setStage({ name: 'checking', text: `Нужен пароль ключа ${lockedKey.name}…` })
      const status = await unlock(lockedKey, run)
      if (run !== generation.current || status.state === 'connected') return
      setNote('Ключ уже добавлен на сервер, но без пароля им нельзя пользоваться.')
      setStage({ name: 'add' })
      return
    }
    if (!list.length) {
      setStage({ name: 'create' })
      return
    }
    const preferred = preferPath ? list.find((key) => key.path === preferPath) : null
    setSelectedId((preferred ?? list.find((key) => key.publicKey) ?? list[0]).id)
    setStage({ name: 'add' })
  }, [finish, target, unlock])

  useEffect(() => {
    void scan().catch((reason: Error) => {
      setNote(reason.message)
      setStage({ name: 'blocked', probe: 'offline' })
    })
    return () => { generation.current++ }
  }, [scan])

  const recheck = useCallback(async (): Promise<void> => {
    if (!selected?.publicKey || !target || checking) return
    const run = generation.current
    setChecking(true)
    setNote(null)
    try {
      const status = await appApi.sshCheckKey(selected, target)
      if (run !== generation.current) return
      setStatuses((current) => ({ ...current, [selected.id]: status }))
      if (status.state === 'connected') await finish(selected, status.account, run)
      else if (status.state === 'locked') await unlock(selected, run)
      else if (status.state === 'rejected') setNote('Сервер пока не видит этот ключ. Проверь, что нажата кнопка добавления на сайте, и что ты вошёл в нужный аккаунт.')
      else if (status.state === 'failed') setNote(status.issue ? issueSummary(status.issue, target.host) : status.message)
    } finally {
      setChecking(false)
    }
  }, [checking, finish, selected, target, unlock])

  // Coming back from the browser is the moment the key has just been added.
  const stageName = stage.name
  useEffect(() => {
    if (stageName !== 'add' || !opened) return
    const onFocus = (): void => void recheck()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [opened, recheck, stageName])

  const copyAndOpen = async (): Promise<void> => {
    if (!selected?.publicKey) return
    await appApi.copyText(selected.publicKey)
    setOpened(true)
    await appApi.openExternal(sshKeysPage(provider, webHost))
  }
  const copyOnly = async (): Promise<void> => {
    if (!selected?.publicKey) return
    await appApi.copyText(selected.publicKey)
    setOpened(true)
    setNote('Публичный ключ скопирован.')
  }
  const derive = async (): Promise<void> => {
    if (!selected?.path) return
    const path = selected.path
    setNote(null)
    try {
      await appApi.sshDerivePublicKey(path)
      await scan(path)
    } catch (reason) {
      setNote((reason as Error).message)
    }
  }
  const finishAndClose = async (result: AccessResult): Promise<void> => {
    if (result.url && repoPath && remote) await repoClient(repoPath).setRemoteUrl(remote, result.url)
    if (onRetry) onRetry(result)
    else onClose()
  }

  const chooseProvider = (next: ForgeKind): void => {
    setProvider(next)
    if (!url && hostInput === STANDARD_HOST[provider]) {
      setHostInput(STANDARD_HOST[next])
      setFreeHost(STANDARD_HOST[next])
    }
  }
  const applyHost = (): void => {
    const clean = hostInput.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (clean && clean !== freeHost) setFreeHost(clean)
  }

  if (url && !target) {
    return (
      <Modal title="Доступ к серверу" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Закрыть</button>}>
        <div className="banner warn"><Icon name="warning" />{issue ? issueSummary(issue) : 'Для этого адреса настройка ключа не нужна.'}</div>
      </Modal>
    )
  }
  const host = target?.host ?? ''
  const showProviderChoice = !url || (!known && stage.name === 'add')
  const keyList = keys.length > 0 && stage.name !== 'done' && stage.name !== 'create' && (
    <div className="key-list">
      {keys.map((key) => (
        <label key={key.id} className={`key-row ${selected?.id === key.id ? 'active' : ''}`}>
          <input type="radio" name="ssh-key" checked={selected?.id === key.id} onChange={() => setSelectedId(key.id)} />
          <Icon name="key" size={14} />
          <span className="key-name truncate" title={key.path ?? key.name}>{key.name}</span>
          {key.type && <span className="muted">{key.type}</span>}
          {statusPill(statuses[key.id])}
        </label>
      ))}
    </div>
  )

  return (
    <Modal title={`Подключение к ${host}`} wide onClose={onClose}>
      {issue && stage.name !== 'done' && <div className="banner warn"><Icon name="warning" />{issueSummary(issue, host)}</div>}
      {showProviderChoice && (
        <div className="segmented" role="group" aria-label="Сервер">
          {(['github', 'gitlab'] as const).map((kind) => (
            <button key={kind} className={provider === kind ? 'active' : ''} onClick={() => chooseProvider(kind)}>{FORGE_NAME[kind]}</button>
          ))}
        </div>
      )}
      {!url && (
        <label className="field">
          <span>Адрес сервера</span>
          <input value={hostInput} spellCheck={false} onChange={(event) => setHostInput(event.target.value)} onBlur={applyHost} onKeyDown={(event) => { if (event.key === 'Enter') applyHost() }} />
        </label>
      )}
      {stage.name === 'checking' && <div className="access-progress"><span className="spinner" />{stage.text}</div>}
      {stage.name === 'blocked' && (
        <>
          <div className="banner danger"><Icon name="warning" />{note ?? PROBE_TEXT[stage.probe]}</div>
          <div className="inline-actions access-actions"><button className="btn btn-primary" onClick={() => void scan()}>Проверить снова</button></div>
        </>
      )}
      {stage.name === 'create' && (
        <CreateKeyForm
          onCreated={(path) => void scan(path)}
          onBack={keys.length ? () => setStage({ name: 'add' }) : undefined}
        />
      )}
      {stage.name === 'add' && (
        <>
          <p className="prose">Нужно добавить ключ на {FORGE_NAME[provider]}. Вход в аккаунт в приложении не нужен, всё делается на сайте.</p>
          {keyList}
          {selected && !selected.publicKey && (
            <div className="banner warn">
              <Icon name="warning" />
              <div>
                Рядом с ключом {selected.name} нет публичной части. Её можно восстановить из самого ключа.
                <button className="btn btn-small" onClick={() => void derive()}>Восстановить</button>
              </div>
            </div>
          )}
          {selected?.publicKey && (
            <>
              <div className="key-box" aria-label="Публичный ключ"><code>{selected.publicKey}</code></div>
              <div className="inline-actions access-actions">
                <button className="btn btn-primary" onClick={() => void copyAndOpen()}><Icon name="external" size={14} />Скопировать и открыть {FORGE_NAME[provider]}</button>
                <button className="btn" onClick={() => void copyOnly()}>Только скопировать</button>
                {statuses[selected.id]?.state === 'locked' && (
                  <button className="btn" onClick={() => void unlock(selected, generation.current)}>Ввести пароль</button>
                )}
              </div>
              <ol className="access-steps">
                {ADD_STEPS[provider].map((step) => <li key={step}>{step}</li>)}
              </ol>
            </>
          )}
          {note && <div className="banner"><Icon name="warning" />{note}</div>}
          <div className="inline-actions access-actions">
            <button className="btn" disabled={checking || !selected?.publicKey} onClick={() => void recheck()}>{checking ? 'Проверяю…' : 'Проверить подключение'}</button>
            <button className="btn btn-ghost" onClick={() => setStage({ name: 'create' })}><Icon name="plus" size={14} />Создать новый ключ</button>
          </div>
        </>
      )}
      {stage.name === 'no-access' && (
        <>
          <div className="banner danger">
            <Icon name="warning" />
            <div>
              {stage.account
                ? <>Ключ подключён к аккаунту <b>{stage.account}</b>, но у него нет доступа к этому репозитории, или адрес неверный.</>
                : 'Ключ подключён, но сервер не открывает этот репозиторий. Возможно, нет доступа или адрес неверный.'}
              {stage.message && <div className="mono-list">{stage.message}</div>}
            </div>
          </div>
          {keyList}
          <div className="inline-actions access-actions">
            <button className="btn btn-primary" onClick={() => void scan()}>Проверить снова</button>
            <button className="btn" onClick={() => setStage({ name: 'add' })}>Добавить другой ключ</button>
            <button className="btn btn-ghost" onClick={() => setStage({ name: 'create' })}><Icon name="plus" size={14} />Создать новый ключ</button>
          </div>
        </>
      )}
      {stage.name === 'done' && (
        <>
          <div className="access-success">
            <Icon name="check" size={20} />
            <div>
              <b>{stage.account ? `Подключено как ${stage.account}` : 'Подключено'}</b>
              <span className="muted">{selected ? `Ключ ${selected.name}` : ''}{stage.result.keyPath && repoPath ? ', закреплён за этим репозиторием' : ''}</span>
            </div>
          </div>
          {stage.result.url && (
            <p className="prose">
              Адрес {remote ?? 'репозитория'} сейчас работает через HTTPS. Чтобы использовать ключ, он станет таким: <code>{stage.result.url}</code>
            </p>
          )}
          <div className="inline-actions access-actions">
            <button className="btn btn-primary" autoFocus onClick={() => void finishAndClose(stage.result)}>
              {stage.result.url ? 'Переключить на SSH' : ''}{stage.result.url && onRetry ? ' и повторить' : ''}{!stage.result.url && onRetry ? 'Повторить действие' : ''}{!stage.result.url && !onRetry ? 'Готово' : ''}
            </button>
            {stage.result.url && <button className="btn btn-ghost" onClick={onClose}>Оставить как есть</button>}
          </div>
        </>
      )}
    </Modal>
  )
}
