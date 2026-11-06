import { useEffect, useState, type ReactNode } from 'react'
import { appApi, platform } from '../api'
import { Icon, Modal } from '../components/ui'

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

export function Welcome({ onOpen }: { onOpen: (repo: string) => void }): ReactNode {
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cloning, setCloning] = useState(false)
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
          <button className="btn" onClick={() => setCloning(true)}><Icon name="cloud" size={15} />Клонировать</button>
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
      {cloning && <CloneDialog onClose={() => setCloning(false)} onOpen={onOpen} />}
    </div>
  )
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
