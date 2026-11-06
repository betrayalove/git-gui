import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { buildPlan, EMPTY_DRAFT } from '../../shared/draft'
import type { UpdateInfo } from '../../shared/types'
import { appApi, platform } from './api'
import { DialogProvider, PushDialog, ReviewDialog, useDialogs } from './components/dialogs'
import { Sidebar } from './components/Sidebar'
import { ContextMenu, Icon, type MenuItem } from './components/ui'
import { plural } from './format'
import { RepoProvider, useRepo } from './store'
import { ChangesView } from './views/ChangesView'
import { HistoryView } from './views/HistoryView'
import { Inspector } from './views/Inspector'
import { JournalView } from './views/JournalView'
import { ScheduleView } from './views/ScheduleView'
import { SettingsDialog } from './views/SettingsDialog'
import { StashView } from './views/StashView'
import { Welcome } from './views/Welcome'

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function Toolbar({ search, onSearch }: { search: string; onSearch: (value: string) => void }): ReactNode {
  const { repo, snapshot, client, run, toast, closeRepo, busy, view } = useRepo()
  const { show, close } = useDialogs()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const status = snapshot?.status
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')
  const pullMenu = (x: number, y: number): void => setMenu({
    x, y,
    items: [
      { label: 'Только перемотка', run: () => void run('Подтягиваю', () => client.pull('ff-only')) },
      { label: 'С rebase', run: () => void run('Подтягиваю', () => client.pull('rebase')) },
      { label: 'С merge', run: () => void run('Подтягиваю', () => client.pull('merge')) }
    ]
  })
  return (
    <header className={`toolbar platform-${platform}`}>
      <button className="repo-switch" onClick={closeRepo} title={repo}>
        <Icon name="folder" size={14} />
        <b>{baseName(repo)}</b>
      </button>
      <span className="branch-name">
        <Icon name="branch" size={13} />
        {status?.head ?? (status?.detached ? `HEAD ${status.headSha?.slice(0, 7)}` : '…')}
      </span>
      <div className="toolbar-actions">
        <button className="tool" onClick={() => void run('Обновляю', async () => {
          await client.fetchAll()
          toast('success', 'Данные с сервера обновлены')
        })}><Icon name="fetch" />Fetch</button>
        <button
          className="tool"
          disabled={!status?.upstream}
          onClick={() => void run('Подтягиваю', () => client.pull('ff-only'))}
          onContextMenu={(event) => { event.preventDefault(); pullMenu(event.clientX, event.clientY) }}
          title="Правая кнопка: выбрать способ"
        >
          <Icon name="pull" />Pull{status?.behind ? <span className="count">{status.behind}</span> : null}
        </button>
        <button className="tool" disabled={!status?.head} onClick={() => show(<PushDialog branch={status!.head!} />)}>
          <Icon name="push" />Push{status?.ahead ? <span className="count">{status.ahead}</span> : null}
        </button>
        <span className="tool-sep" />
        <button
          className="tool"
          disabled={!lastApplied}
          title={lastApplied ? `Отменить: ${lastApplied.description}` : 'Нет правок для отмены'}
          onClick={() => void run('Отменяю', () => client.undoEntry(lastApplied!.id))}
        ><Icon name="undo" />Отменить</button>
      </div>
      <div className="toolbar-right">
        {busy && <span className="busy"><span className="spinner" />{busy}…</span>}
        <button className="icon-btn" title="Настройки" aria-label="Настройки" onClick={() => show(<SettingsDialog onClose={close} />)}><Icon name="gear" /></button>
        {view === 'history' && (
          <label className="search">
            <Icon name="search" size={14} />
            <input value={search} placeholder="Поиск по истории" aria-label="Поиск по истории" onChange={(event) => onSearch(event.target.value)} />
          </label>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </header>
  )
}

function DraftBar(): ReactNode {
  const { draftCount, commits, draft, setDraft } = useRepo()
  const { show } = useDialogs()
  if (!draftCount) return null
  return (
    <div className="draft-bar" role="status">
      <span className="draft-dot" />
      <b>Черновик: {plural(draftCount, 'правка', 'правки', 'правок')}</b>
      <span className="muted">Репозиторий пока не изменён</span>
      <span className="spacer" />
      <button className="btn btn-ghost" onClick={() => setDraft(() => EMPTY_DRAFT)}>Сбросить</button>
      <button className="btn btn-primary" onClick={() => show(<ReviewDialog plan={buildPlan(commits, draft)} />)}>Предпросмотр и применение</button>
    </div>
  )
}

function Toasts(): ReactNode {
  const { toasts, dismissToast } = useRepo()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.text}</span>
          {toast.action && <button className="link" onClick={() => { dismissToast(toast.id); toast.action!.run() }}>{toast.action.label}</button>}
          <button className="icon-btn" aria-label="Закрыть" onClick={() => dismissToast(toast.id)}><Icon name="close" size={13} /></button>
        </div>
      ))}
    </div>
  )
}

function Workspace(): ReactNode {
  const { view, snapshot, client, run } = useRepo()
  const [search, setSearch] = useState('')
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && lastApplied) {
        event.preventDefault()
        void run('Отменяю', () => client.undoEntry(lastApplied.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, lastApplied, run])

  return (
    <div className="workspace">
      <Toolbar search={search} onSearch={setSearch} />
      <div className="workspace-body">
        <Sidebar />
        <main className="main-pane">
          {view === 'history' && (
            <div className="history-layout">
              <HistoryView search={search} />
              <Inspector />
            </div>
          )}
          {view === 'changes' && <ChangesView />}
          {view === 'stash' && <StashView />}
          {view === 'schedule' && <ScheduleView />}
          {view === 'journal' && <JournalView />}
          <DraftBar />
        </main>
      </div>
      <Toasts />
    </div>
  )
}

function UpdateNotice(): ReactNode {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void appApi.updateChecksEnabled().then(async (enabled) => {
      if (!enabled) return
      const info = await appApi.checkForUpdates()
      if (!cancelled && info.available) setUpdate(info)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  if (!update?.url) return null
  return (
    <div className="update-notice" role="status">
      <span>Вышла версия {update.latest}</span>
      <button className="link" onClick={() => void appApi.openExternal(update.url!)}>Скачать</button>
      <button className="icon-btn" aria-label="Скрыть" onClick={() => setUpdate(null)}><Icon name="close" size={13} /></button>
    </div>
  )
}

export function App(): ReactNode {
  const [repo, setRepo] = useState<string | null>(null)
  const close = useCallback(() => setRepo(null), [])
  return (
    <>
      {repo ? (
        <RepoProvider key={repo} repo={repo} onClose={close}>
          <DialogProvider>
            <Workspace />
          </DialogProvider>
        </RepoProvider>
      ) : <Welcome onOpen={setRepo} />}
      <UpdateNotice />
    </>
  )
}
