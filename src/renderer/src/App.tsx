import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { buildPlan, EMPTY_DRAFT } from '../../shared/draft'
import type { UpdateInfo } from '../../shared/types'
import { appApi, platform } from './api'
import { AccessDialog } from './components/AccessDialog'
import { DialogProvider, PushDialog, ReviewDialog, useDialogs } from './components/dialogs'
import { PullDialog } from './components/MergeDialogs'
import { PromptHost } from './components/PromptHost'
import { Sidebar } from './components/Sidebar'
import { Icon } from './components/ui'
import { plural } from './format'
import { RepoProvider, useRepo } from './store'
import { ChangesView } from './views/ChangesView'
import { DependenciesView } from './views/DependenciesView'
import { FilesView } from './views/FilesView'
import { HistoryView } from './views/HistoryView'
import { Inspector } from './views/Inspector'
import { JournalView } from './views/JournalView'
import { ScheduleView } from './views/ScheduleView'
import { SettingsDialog } from './views/SettingsDialog'
import { StashView } from './views/StashView'
import { Welcome } from './views/Welcome'
import { t, translateRecord } from '../../shared/i18n'

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function Toolbar(): ReactNode {
  const { repo, snapshot, client, run, toast, closeRepo, busy, view, search, setSearch, searchMode, setSearchMode } = useRepo()
  const { show, close } = useDialogs()
  const status = snapshot?.status
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')
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
        <button className="tool" onClick={() => void run(t('Обновляю'), async () => {
          await client.fetchAll()
          toast('success', t('Данные с сервера обновлены'))
        })}><Icon name="fetch" />Fetch</button>
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
  const { view, snapshot, client, run, repo, access, showAccess, reload } = useRepo()
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z' && lastApplied) {
        event.preventDefault()
        void run(t('Отменяю'), () => client.undoEntry(lastApplied.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [client, lastApplied, run])

  return (
    <div className="workspace">
      <Toolbar />
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

const OPEN_REPO_KEY = 'chronicle:open-repository'

/** The open repository survives a reload of the window, such as after switching the language. */
function readOpenRepo(): string | null {
  try {
    return sessionStorage.getItem(OPEN_REPO_KEY)
  } catch {
    return null
  }
}

export function App(): ReactNode {
  const [repo, setRepo] = useState<string | null>(readOpenRepo)
  const close = useCallback(() => setRepo(null), [])
  useEffect(() => {
    try {
      if (repo) sessionStorage.setItem(OPEN_REPO_KEY, repo)
      else sessionStorage.removeItem(OPEN_REPO_KEY)
    } catch {
      // Without storage a reload only returns to the start screen.
    }
  }, [repo])
  return (
    <>
      {repo ? (
        <RepoProvider key={repo} repo={repo} onClose={close} onOpen={setRepo}>
          <DialogProvider>
            <Workspace />
          </DialogProvider>
        </RepoProvider>
      ) : <Welcome onOpen={setRepo} />}
      <UpdateNotice />
      <PromptHost />
    </>
  )
}
