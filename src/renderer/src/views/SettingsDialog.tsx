import { useEffect, useState, type ReactNode } from 'react'
import type { ForgeAccount, ForgeKind } from '../../../shared/types'
import { appApi } from '../api'
import { Icon, Modal } from '../components/ui'

const TOKEN_HELP: Record<ForgeKind, { url: (host: string) => string; hint: string }> = {
  github: {
    url: () => 'https://github.com/settings/tokens/new?scopes=repo&description=Chronicle',
    hint: 'Нужен доступ repo.'
  },
  gitlab: {
    url: (host) => `https://${host}/-/user_settings/personal_access_tokens?name=Chronicle&scopes=api,write_repository`,
    hint: 'Нужны доступы api и write_repository.'
  }
}

export function SettingsDialog({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }): ReactNode {
  const [accounts, setAccounts] = useState<ForgeAccount[]>([])
  const [kind, setKind] = useState<ForgeKind>('github')
  const [host, setHost] = useState('github.com')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autostart, setAutostart] = useState<{ available: boolean; enabled: boolean } | null>(null)

  useEffect(() => {
    void appApi.accounts().then(setAccounts)
    void appApi.autostart().then(setAutostart)
  }, [])

  const attempt = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setAccounts(await appApi.accounts())
      onChanged?.()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const changeKind = (next: ForgeKind): void => {
    setKind(next)
    if (host === 'github.com' || host === 'gitlab.com') setHost(next === 'github' ? 'github.com' : 'gitlab.com')
  }
  const add = (): Promise<void> => attempt(async () => {
    await appApi.addAccount(kind, host, token)
    setToken('')
  })

  return (
    <Modal title="Настройки" onClose={onClose} wide>
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      <section className="settings-section">
        <h3>Аккаунты</h3>
        {accounts.map((account) => (
          <div className="account-row" key={account.id}>
            <Icon name="cloud" />
            <div>
              <b>{account.username}</b>
              <span className="muted">{account.kind === 'github' ? 'GitHub' : 'GitLab'} · {account.host}</span>
            </div>
            <button className="btn btn-small btn-ghost danger-text" onClick={() => void attempt(() => appApi.removeAccount(account.id))}>Отключить</button>
          </div>
        ))}
        {!accounts.length && <p className="hint">Аккаунт нужен, чтобы видеть запросы, переносить их при переименовании ветки и проверять защиту. Обычные push и pull работают и без него.</p>}
      </section>
      <section className="settings-section">
        <h3>Подключить аккаунт</h3>
        <div className="segmented">
          <button className={kind === 'github' ? 'active' : ''} onClick={() => changeKind('github')}>GitHub</button>
          <button className={kind === 'gitlab' ? 'active' : ''} onClick={() => changeKind('gitlab')}>GitLab</button>
        </div>
        <label className="field">
          <span>Адрес сервера</span>
          <input value={host} spellCheck={false} onChange={(event) => setHost(event.target.value)} />
        </label>
        <label className="field">
          <span>Токен доступа</span>
          <input type="password" value={token} spellCheck={false} autoComplete="off" onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && token.trim()) void add() }} />
        </label>
        <p className="hint">
          {TOKEN_HELP[kind].hint} Токен шифруется средствами системы и не покидает основной процесс приложения.
        </p>
        <div className="inline-actions">
          <button className="btn btn-primary" disabled={busy || !token.trim() || !host.trim()} onClick={() => void add()}>{busy ? 'Проверяю…' : 'Подключить'}</button>
          <button className="btn" disabled={!host.trim()} onClick={() => void appApi.openExternal(TOKEN_HELP[kind].url(host.trim()))}><Icon name="external" size={14} />Создать токен</button>
          {kind === 'github' && host === 'github.com' && (
            <button className="btn" disabled={busy} onClick={() => void attempt(() => appApi.addAccountFromGitHubCli())}>Взять вход из GitHub CLI</button>
          )}
        </div>
      </section>
      <section className="settings-section">
        <h3>Запуск</h3>
        <label className="check">
          <input
            type="checkbox"
            disabled={!autostart?.available}
            checked={autostart?.enabled ?? false}
            onChange={(event) => {
              const enabled = event.target.checked
              void attempt(async () => {
                await appApi.setAutostart(enabled)
                setAutostart(await appApi.autostart())
              })
            }}
          />
          <span>Запускать при входе в систему, чтобы отложенные публикации выходили вовремя</span>
        </label>
        {autostart && !autostart.available && <p className="hint">Доступно в установленном приложении.</p>}
      </section>
    </Modal>
  )
}
