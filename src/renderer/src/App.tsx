import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { buildPlan, EMPTY_DRAFT } from '../../shared/draft'
import type { UpdateInfo } from '../../shared/types'
import { appApi, platform } from './api'
import { AccessDialog } from './components/AccessDialog'
import { CommandPalette } from './components/CommandPalette'
import { DialogProvider, PushDialog, ReviewDialog, useDialogs } from './components/dialogs'
import { PullDialog } from './components/MergeDialogs'
import { PromptHost } from './components/PromptHost'
import { Sidebar, VIEWS } from './components/Sidebar'
import { Icon } from './components/ui'
import { baseName, formatRelative, plural } from './format'
import { RepoProvider, useRepo } from './store'
import { isModifier, shortcut } from './keys'
import { TabsContext, useTabs, type Tab, type TabsValue } from './tabs'
import { ChangesView } from './views/ChangesView'
import { DependenciesView } from './views/DependenciesView'
import { FilesView } from './views/FilesView'
import { HistoryView } from './views/HistoryView'
import { Inspector } from './views/Inspector'
import { JournalView } from './views/JournalView'
import { RequestsView } from './views/RequestsView'
import { ScheduleView } from './views/ScheduleView'
import { SettingsDialog } from './views/SettingsDialog'
import { StashView } from './views/StashView'
import { Welcome } from './views/Welcome'
import { t, translateRecord } from '../../shared/i18n'


function TabStrip(): ReactNode {
  const { tabs, activeId, select, close, add } = useTabs()
  return (
    <div className="tabs" role="tablist" aria-label={t('Открытые репозитории')}>
      {tabs.map((tab) => {
        const label = tab.repo ? baseName(tab.repo) : t('Новая вкладка')
        return (
          <div key={tab.id} className={`tab ${tab.id === activeId ? 'active' : ''}`}>
            <button role="tab" aria-selected={tab.id === activeId} className="repo-switch" title={tab.repo ?? undefined} onClick={() => select(tab.id)}>
              <Icon name="folder" size={14} />
              <b>{label}</b>
            </button>
            <button className="tab-close" aria-label={t('Закрыть вкладку {name}', { name: label })} title={t('Закрыть вкладку')} onClick={() => close(tab.id)}>
              <Icon name="close" size={11} />
            </button>
          </div>
        )
      })}
      <button className="icon-btn tab-add" aria-label={t('Новая вкладка')} title={t('Открыть ещё один репозиторий')} onClick={add}><Icon name="plus" size={14} /></button>
    </div>
  )
}

function fetchTitle(lastFetch: string | null | undefined, error: string | null): string {
  const last = lastFetch ? t('Последний fetch: {time}', { time: formatRelative(lastFetch) }) : t('Fetch ещё не запускался')
  return error ? `${last}\n${t('Фоновый fetch не удался: {reason}', { reason: error.split('\n')[0] })}` : last
}

function Toolbar({ focusSearch }: { focusSearch: () => void }): ReactNode {
  const { snapshot, client, run, busy, view, search, setSearch, searchMode, setSearchMode, autoFetchError, fetchNow, active } = useRepo()
  const { show, close } = useDialogs()
  const status = snapshot?.status
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')
  return (
    <header className={`toolbar platform-${platform}`}>
      {/* Every tab draws its toolbar; only the one on screen carries the tabs, so they exist once. */}
      {active && <TabStrip />}
      <span className="branch-name">
        <Icon name="branch" size={13} />
        {status?.head ?? (status?.detached ? `HEAD ${status.headSha?.slice(0, 7)}` : '…')}
      </span>
      <div className="toolbar-actions">
        <button className={`tool ${autoFetchError ? 'tool-warn' : ''}`} title={fetchTitle(snapshot?.lastFetch, autoFetchError)} onClick={fetchNow}><Icon name="fetch" />Fetch</button>
        <button
          className="tool"
          disabled={!status?.upstream}
          onClick={() => show(<PullDialog />)}
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
          title={lastApplied ? t('Отменить: {description}', { description: translateRecord(lastApplied.description) }) : t('Нет правок для отмены')}
          onClick={() => void run(t('Отменяю'), () => client.undoEntry(lastApplied!.id))}
        ><Icon name="undo" />{t('Отменить')}</button>
      </div>
      <div className="toolbar-right">
        {busy && <span className="busy"><span className="spinner" />{busy}…</span>}
        <button className="icon-btn" title={`${t('Команды')} (${shortcut('K')})`} aria-label={t('Команды')} onClick={() => show(<CommandPalette focusSearch={focusSearch} />)}><Icon name="command" /></button>
        <button className="icon-btn" title={t('Настройки')} aria-label={t('Настройки')} onClick={() => show(<SettingsDialog onClose={close} />)}><Icon name="gear" /></button>
        {view === 'history' && (
          <label className="search">
            <Icon name="search" size={14} />
            <input
              value={search}
              placeholder={searchMode === 'content' ? t('Поиск в изменениях') : t('Поиск по истории')}
              aria-label={searchMode === 'content' ? t('Поиск в изменениях') : t('Поиск по истории')}
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              className={`search-mode ${searchMode === 'content' ? 'active' : ''}`}
              aria-pressed={searchMode === 'content'}
              title={searchMode === 'content' ? t('Ищу в изменённых строках. Нажми, чтобы искать в сообщениях') : t('Ищу в сообщениях, авторах и SHA. Нажми, чтобы искать в изменённых строках')}
              onClick={() => setSearchMode(searchMode === 'content' ? 'message' : 'content')}
            >{'{ }'}</button>
          </label>
        )}
      </div>
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
      <b>{t('Черновик:')} {plural(draftCount, 'правка', 'правки', 'правок')}</b>
      <span className="muted">{t('Репозиторий пока не изменён')}</span>
      <span className="spacer" />
      <button className="btn btn-ghost" onClick={() => setDraft(() => EMPTY_DRAFT)}>{t('Сбросить')}</button>
      <button className="btn btn-primary" onClick={() => show(<ReviewDialog plan={buildPlan(commits, draft)} />)}>{t('Предпросмотр и применение')}</button>
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
          <button className="icon-btn" aria-label={t('Закрыть')} onClick={() => dismissToast(toast.id)}><Icon name="close" size={13} /></button>
        </div>
      ))}
    </div>
  )
}

function Workspace(): ReactNode {
  const { view, setView, snapshot, client, run, repo, access, showAccess, reload, active } = useRepo()
  const { show, close } = useDialogs()
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')
  const root = useRef<HTMLDivElement>(null)

  const focusSearch = useCallback((): void => {
    setView('history')
    // The search field exists only in the history, so it is looked up once that view is drawn.
    setTimeout(() => root.current?.querySelector<HTMLInputElement>('.search input')?.focus())
  }, [setView])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      // An open dialog keeps the keys, so a shortcut never throws away what is typed in it.
      if (root.current?.querySelector('[role="dialog"]')) return
      const key = event.key.toLowerCase()
      if (isModifier(event) && !event.shiftKey && !event.altKey) {
        const viewIndex = Number(key) - 1
        if (key === 'k') {
          event.preventDefault()
          return show(<CommandPalette focusSearch={focusSearch} />)
        }
        if (key === 'f') {
          event.preventDefault()
          return focusSearch()
        }
        if (key === ',') {
          event.preventDefault()
          return show(<SettingsDialog onClose={close} />)
        }
        if (Number.isInteger(viewIndex) && VIEWS[viewIndex]) {
          event.preventDefault()
          return setView(VIEWS[viewIndex].id)
        }
      }
      const target = event.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && key === 'z' && lastApplied) {
        event.preventDefault()
        void run(t('Отменяю'), () => client.undoEntry(lastApplied.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, client, close, focusSearch, lastApplied, run, setView, show])

  return (
    <div className="workspace" ref={root}>
      <Toolbar focusSearch={focusSearch} />
      <div className="workspace-body">
        <Sidebar />
        <main className="main-pane">
          {view === 'history' && (
            <div className="history-layout">
              <HistoryView />
              <Inspector />
            </div>
          )}
          {view === 'changes' && <ChangesView />}
          {view === 'requests' && <RequestsView />}
          {view === 'files' && <FilesView />}
          {view === 'stash' && <StashView />}
          {view === 'schedule' && <ScheduleView />}
          {view === 'dependencies' && <DependenciesView />}
          {view === 'journal' && <JournalView />}
          <DraftBar />
        </main>
      </div>
      <Toasts />
      {access && snapshot?.forge && (
        <AccessDialog
          url={snapshot.forge.url}
          repoPath={repo}
          remote={snapshot.forge.remote}
          issue={access.issue}
          onClose={() => { showAccess(null); void reload() }}
          onRetry={access.retry && (() => { showAccess(null); access.retry!() })}
        />
      )}
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
      <span>{t('Вышла версия')} {update.latest}</span>
      <button className="link" onClick={() => void appApi.openExternal(update.url!)}>{t('Скачать')}</button>
      <button className="icon-btn" aria-label={t('Скрыть')} onClick={() => setUpdate(null)}><Icon name="close" size={13} /></button>
    </div>
  )
}

const TABS_KEY = 'chronicle:tabs'

/** The open tabs survive a reload of the window, such as after switching the language. */
function readTabs(): { tabs: Tab[]; activeId: number } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(TABS_KEY) ?? 'null') as { repos: (string | null)[]; active: number } | null
    if (saved?.repos.length) {
      return { tabs: saved.repos.map((repo, id) => ({ id, repo })), activeId: Math.min(saved.active, saved.repos.length - 1) }
    }
  } catch {
    // Without storage a reload only returns to the start screen.
  }
  return { tabs: [{ id: 0, repo: null }], activeId: 0 }
}

let nextTabId = 1000

export function App(): ReactNode {
  const [{ tabs, activeId }, setState] = useState(readTabs)
  useEffect(() => {
    try {
      sessionStorage.setItem(TABS_KEY, JSON.stringify({ repos: tabs.map((tab) => tab.repo), active: tabs.findIndex((tab) => tab.id === activeId) }))
    } catch {
      // See readTabs.
    }
  }, [tabs, activeId])

  const select = useCallback((id: number) => setState((current) => ({ ...current, activeId: id })), [])
  const close = useCallback((id: number) => setState((current) => {
    const index = current.tabs.findIndex((tab) => tab.id === id)
    const rest = current.tabs.filter((tab) => tab.id !== id)
    if (!rest.length) {
      const blank = { id: nextTabId++, repo: null }
      return { tabs: [blank], activeId: blank.id }
    }
    const activeId = current.activeId === id ? rest[Math.min(index, rest.length - 1)].id : current.activeId
    return { tabs: rest, activeId }
  }), [])
  const add = useCallback(() => setState((current) => {
    const blank = current.tabs.find((tab) => !tab.repo)
    if (blank) return { ...current, activeId: blank.id }
    const tab = { id: nextTabId++, repo: null }
    return { tabs: [...current.tabs, tab], activeId: tab.id }
  }), [])
  // A repository open in another tab is shown there rather than twice.
  const openIn = useCallback((id: number, repo: string) => setState((current) => {
    const existing = current.tabs.find((tab) => tab.repo === repo)
    if (existing) {
      const opener = current.tabs.find((tab) => tab.id === id)
      const tabs = opener?.repo ? current.tabs : current.tabs.filter((tab) => tab.id !== id)
      return { tabs, activeId: existing.id }
    }
    return { ...current, tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, repo } : tab)) }
  }), [])

  const cycle = useCallback((step: number) => setState((current) => {
    const index = current.tabs.findIndex((tab) => tab.id === current.activeId)
    const next = (index + step + current.tabs.length) % current.tabs.length
    return { ...current, activeId: current.tabs[next].id }
  }), [])

  // Tab shortcuts work on every tab, the start screen included.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isModifier(event) && !event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        add()
      } else if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        cycle(event.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [add, cycle])

  const value: TabsValue = { tabs, activeId, select, close, add, cycle }
  return (
    <TabsContext.Provider value={value}>
      {tabs.map((tab) => (
        <div key={tab.id} className="tab-page" hidden={tab.id !== activeId}>
          {tab.repo ? (
            <RepoProvider key={tab.repo} repo={tab.repo} active={tab.id === activeId} onOpen={(repo) => openIn(tab.id, repo)}>
              <DialogProvider>
                <Workspace />
              </DialogProvider>
            </RepoProvider>
          ) : tabs.length > 1 ? (
            <div className="workspace">
              <header className={`toolbar platform-${platform}`}><TabStrip /></header>
              <Welcome onOpen={(repo) => openIn(tab.id, repo)} />
            </div>
          ) : <Welcome onOpen={(repo) => openIn(tab.id, repo)} />}
        </div>
      ))}
      <UpdateNotice />
      <PromptHost />
    </TabsContext.Provider>
  )
}
