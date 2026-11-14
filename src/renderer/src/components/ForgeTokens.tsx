import { useEffect, useRef, useState, type ReactNode } from 'react'
import { tokenPageUrl } from '../../../shared/remote-url'
import type { ForgeKind } from '../../../shared/types'
import { appApi } from '../api'
import { addForgeToken, removeForgeToken, useForgeAccounts } from '../forge-accounts'
import { Icon } from './ui'
import { t } from '../../../shared/i18n'

const KIND_NAME: Record<ForgeKind, string> = { github: 'GitHub', gitlab: 'GitLab' }

/** Saved tokens and a form for a new one, for the settings. */
export function ForgeTokensSection({ initialHost }: { initialHost?: string }): ReactNode {
  const accounts = useForgeAccounts()
  const [host, setHost] = useState(initialHost ?? 'github.com')
  const [kind, setKind] = useState<ForgeKind>(initialHost && /(^|\.)gitlab\./.test(initialHost) ? 'gitlab' : 'github')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const tokenField = useRef<HTMLInputElement>(null)

  // Opened to add a token for a repository's server, the form comes into view ready for it.
  useEffect(() => {
    if (!initialHost) return
    tokenField.current?.scrollIntoView({ block: 'center' })
    tokenField.current?.focus()
  }, [initialHost])

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setAdded(null)
    try {
      const account = await addForgeToken(host, kind, token)
      setToken('')
      setAdded(account.saved
        ? t('Готово: {account} на {host}.', { account: account.account, host: account.host })
        : t('Готово: {account} на {host}. В системе нет хранилища паролей, поэтому токен забудется при закрытии приложения.', { account: account.account, host: account.host }))
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const pickHost = (value: string): void => {
    setHost(value)
    if (value === 'github.com') setKind('github')
    if (value === 'gitlab.com') setKind('gitlab')
  }

  return (
    <section className="settings-section">
      <h3>{t('GitHub и GitLab')}</h3>
      <p className="hint settings-hint">{t('С токеном Pull Request и Merge Request видны и создаются прямо в приложении. Для git сам токен не нужен: отправка и загрузка по-прежнему идут через SSH-ключи.')}</p>
      {accounts?.map((account) => removing === account.host ? (
        <div key={account.host} className="banner warn token-row">
          <span>{t('Токен для {host} будет удалён с этого компьютера. На сайте он продолжит работать, пока его там не отзовут.', { host: account.host })}</span>
          <div className="banner-actions">
            <button className="btn btn-small btn-danger" onClick={() => { setRemoving(null); void removeForgeToken(account.host) }}>{t('Удалить')}</button>
            <button className="btn btn-small btn-ghost" onClick={() => setRemoving(null)}>{t('Отмена')}</button>
          </div>
        </div>
      ) : (
        <div key={account.host} className="settings-row token-row">
          <span className="truncate"><b>{account.account}</b> <span className="muted">{KIND_NAME[account.kind]} · {account.host}{account.saved ? '' : ` · ${t('до закрытия приложения')}`}</span></span>
          <button className="btn btn-small btn-ghost danger-text" onClick={() => setRemoving(account.host)}>{t('Удалить токен')}</button>
        </div>
      ))}
      <div className="token-form">
        <div className="field-row">
          <label className="field">
            <span>{t('Сервер')}</span>
            <input list="forge-hosts" value={host} spellCheck={false} onChange={(event) => pickHost(event.target.value)} />
            <datalist id="forge-hosts"><option value="github.com" /><option value="gitlab.com" /></datalist>
          </label>
          <div className="field">
            <span>{t('Тип')}</span>
            <div className="segmented compact" role="group" aria-label={t('Тип сервера')}>
              {(['github', 'gitlab'] as const).map((value) => (
                <button key={value} className={kind === value ? 'active' : ''} aria-pressed={kind === value} onClick={() => setKind(value)}>{KIND_NAME[value]}</button>
              ))}
            </div>
          </div>
        </div>
        <label className="field">
          <span>{t('Токен')}</span>
          <input ref={tokenField} type="password" autoComplete="off" spellCheck={false} value={token} placeholder={kind === 'github' ? 'ghp_…' : 'glpat-…'} onChange={(event) => setToken(event.target.value)} />
        </label>
        {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
        {added && <div className="banner"><Icon name="check" />{added}</div>}
        <div className="inline-actions">
          <button className="btn btn-primary" disabled={busy || !host.trim() || !token.trim()} onClick={() => void save()}>{busy ? t('Проверяю…') : t('Проверить и сохранить')}</button>
          <button className="btn btn-ghost" disabled={!host.trim()} onClick={() => void appApi.openExternal(tokenPageUrl(kind, host.trim().toLowerCase()))}>
            <Icon name="external" size={14} />{t('Создать токен на сайте')}
          </button>
        </div>
        <p className="hint">{kind === 'github'
          ? t('Нужен классический токен с правом repo или новый токен с доступом к Pull Request и содержимому репозиториев.')
          : t('Нужен личный токен с правом api.')}{' '}{t('Токен хранится зашифрованным в системном хранилище паролей и уходит только на этот сервер.')}</p>
      </div>
    </section>
  )
}
