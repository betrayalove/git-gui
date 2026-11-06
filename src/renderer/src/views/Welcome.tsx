import { useEffect, useState, type ReactNode } from 'react'
import { appApi, platform } from '../api'
import { Icon, Modal } from '../components/ui'
import type { ForgeAccount, ForgeRepoSummary } from '../../../shared/types'
import { formatRelative } from '../format'
import { SettingsDialog } from './SettingsDialog'

function CloneDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (repo: string) => void }): ReactNode {
  const [url, setUrl] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const directory = url.trim().replace(/\/+$/, '').split(/[/:]/).at(-1)?.replace(/\.git$/, '') ?? ''
  const submit = async (): Promise<void> => {
    if (!parent) return
    setBusy(true)
    setError(null)
    try {
      onOpen(await appApi.cloneRepository(url.trim(), parent, directory))
    } catch (reason) {
      setError((reason as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Клонировать репозиторий"
      onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className="btn btn-primary" disabled={!url.trim() || !parent || !directory || busy} onClick={() => void submit()}>{busy ? 'Клонирую…' : 'Клонировать'}</button>
      </>}
    >
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      <label className="field">
        <span>URL с GitHub, GitLab или другого сервера</span>
        <input autoFocus value={url} placeholder="git@gitlab.com:team/project.git" onChange={(event) => setUrl(event.target.value)} />
      </label>
      <div className="field">
        <span>Куда</span>
        <button className="btn" onClick={() => void appApi.pickFolder().then(setParent)}><Icon name="folder" size={14} />{parent ?? 'Выбрать папку'}</button>
      </div>
      {parent && directory && <p className="hint">Будет создана папка {directory}</p>}
    </Modal>
  )
}

function AccountCloneDialog({ onClose, onOpen, onOpenSettings }: {
  onClose: () => void
  onOpen: (repo: string) => void
  onOpenSettings: () => void
}): ReactNode {
  const [accounts, setAccounts] = useState<ForgeAccount[] | null>(null)
  const [accountId, setAccountId] = useState('')
  const [repos, setRepos] = useState<ForgeRepoSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cloning, setCloning] = useState<string | null>(null)

  useEffect(() => {
    void appApi.accounts().then((list) => {
      setAccounts(list)
      if (list[0]) setAccountId(list[0].id)
    })
  }, [])
  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    setRepos(null)
    setError(null)
    appApi.accountRepos(accountId)
      .then((list) => { if (!cancelled) setRepos(list) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [accountId])

  const clone = async (repo: ForgeRepoSummary): Promise<void> => {
    const parent = await appApi.pickFolder()
    if (!parent) return
    setCloning(repo.path)
    setError(null)
    try {
      onOpen(await appApi.cloneRepository(repo.cloneUrl, parent, repo.path.split('/').at(-1)!))
    } catch (reason) {
      setError((reason as Error).message)
      setCloning(null)
    }
  }
  const shown = (repos ?? []).filter((repo) => repo.path.toLowerCase().includes(query.trim().toLowerCase()))
  return (
    <Modal title="Открыть из аккаунта" wide onClose={onClose}>
      {accounts && !accounts.length && (
        <div className="prose">
          <p>Аккаунт ещё не подключён.</p>
          <button className="btn btn-primary" onClick={onOpenSettings}>Подключить аккаунт</button>
        </div>
      )}
      {accounts && accounts.length > 1 && (
        <label className="field">
          <span>Аккаунт</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.username} · {account.host}</option>)}
          </select>
        </label>
      )}
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {accounts && accounts.length > 0 && (
        <>
          <label className="field">
            <span>Поиск</span>
            <input autoFocus value={query} placeholder="Название репозитория" onChange={(event) => setQuery(event.target.value)} />
          </label>
          {!repos && !error && <div className="diff-loading">Загружаю список…</div>}
          <div className="repo-list">
            {shown.map((repo) => (
              <button key={repo.path} className="list-card" disabled={Boolean(cloning)} onClick={() => void clone(repo)}>
                <b className="truncate">{repo.path}{repo.private && <span className="pill small repo-private">приватный</span>}</b>
                <span className="muted truncate">
                  {cloning === repo.path ? 'Клонирую…' : `${repo.description ? `${repo.description} · ` : ''}${formatRelative(repo.updatedAt)}`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

export function Welcome({ onOpen }: { onOpen: (repo: string) => void }): ReactNode {
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cloning, setCloning] = useState(false)
  const [fromAccount, setFromAccount] = useState(false)
  const [settings, setSettings] = useState(false)
  useEffect(() => {
    void appApi.recentRepos().then(setRecent)
  }, [])
  const attempt = async (action: () => Promise<string | null>): Promise<void> => {
    setError(null)
    try {
      const repo = await action()
      if (repo) onOpen(repo)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }
  return (
    <div className={`welcome platform-${platform}`}>
      <div className="welcome-card">
        <div className="logo" aria-hidden>
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
            <path d="M13 8v28" stroke="var(--lane-0)" strokeWidth="3" strokeLinecap="round" />
            <path d="M13 28c0-8 18-4 18-14" stroke="var(--lane-1)" strokeWidth="3" strokeLinecap="round" />
            <circle cx="13" cy="10" r="5" fill="var(--lane-0)" />
            <circle cx="13" cy="34" r="5" fill="var(--lane-0)" />
            <circle cx="31" cy="12" r="5" fill="var(--lane-1)" />
          </svg>
        </div>
        <h1>Chronicle</h1>
        <p className="tagline">История git, которую можно редактировать</p>
        {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => void attempt(() => appApi.pickRepository())}><Icon name="folder" size={15} />Открыть репозиторий</button>
          <button className="btn" onClick={() => setFromAccount(true)}><Icon name="cloud" size={15} />Из аккаунта</button>
          <button className="btn" onClick={() => setCloning(true)}><Icon name="fetch" size={15} />Клонировать по адресу</button>
          <button className="btn" onClick={() => void attempt(async () => {
            const folder = await appApi.pickFolder()
            return folder ? appApi.initRepository(folder) : null
          })}><Icon name="plus" size={15} />Создать новый</button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <h2>Недавние</h2>
            {recent.map((repo) => (
              <div className="recent-row" key={repo}>
                <button onClick={() => void attempt(() => appApi.openRepository(repo))} title={repo}>
                  <b>{baseName(repo)}</b>
                  <span className="muted truncate">{repo}</span>
                </button>
                <button
                  className="icon-btn"
                  aria-label={`Убрать ${baseName(repo)} из списка`}
                  title="Убрать из списка"
                  onClick={() => {
                    appApi.forgetRepository(repo)
                      .then(() => setRecent((items) => items.filter((item) => item !== repo)))
                      .catch((reason: Error) => setError(reason.message))
                  }}
                ><Icon name="close" size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>
      <button className="welcome-settings btn btn-ghost" onClick={() => setSettings(true)}><Icon name="gear" size={15} />Настройки</button>
      {cloning && <CloneDialog onClose={() => setCloning(false)} onOpen={onOpen} />}
      {fromAccount && (
        <AccountCloneDialog
          onClose={() => setFromAccount(false)}
          onOpen={onOpen}
          onOpenSettings={() => { setFromAccount(false); setSettings(true) }}
        />
      )}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </div>
  )
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
