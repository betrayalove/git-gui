import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RepoClient, RepoSnapshot } from '../../main/api'
import { EMPTY_DRAFT, draftChangeCount, type Draft } from '../../shared/draft'
import type { Commit } from '../../shared/types'
import { repoClient } from './api'

const PAGE = 5000

function keyOfRefs(snapshot: RepoSnapshot): string {
  return `${snapshot.status.headSha}|${snapshot.refs.map((ref) => `${ref.ref}=${ref.sha}`).join(',')}`
}

export type View = 'history' | 'changes' | 'stash' | 'requests' | 'schedule' | 'journal'

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  text: string
  action?: { label: string; run: () => void }
}

interface RepoContextValue {
  repo: string
  client: RepoClient
  snapshot: RepoSnapshot | null
  commits: Commit[]
  hasMore: boolean
  loadMore: () => Promise<void>
  reload: () => Promise<void>
  draft: Draft
  setDraft: (update: (draft: Draft) => Draft) => void
  draftCount: number
  view: View
  setView: (view: View) => void
  selected: string[]
  setSelected: (shas: string[]) => void
  busy: string | null
  /** Runs an action with a busy indicator; errors become toasts instead of crashes. */
  run: <T>(label: string, action: () => Promise<T>) => Promise<T | undefined>
  toast: (kind: Toast['kind'], text: string, action?: Toast['action']) => void
  toasts: Toast[]
  dismissToast: (id: number) => void
  closeRepo: () => void
}

const RepoContext = createContext<RepoContextValue | null>(null)

export function useRepo(): RepoContextValue {
  const value = useContext(RepoContext)
  if (!value) throw new Error('useRepo used outside RepoProvider')
  return value
}

export function RepoProvider({ repo, onClose, children }: { repo: string; onClose: () => void; children: ReactNode }): ReactNode {
  const client = useMemo(() => repoClient(repo), [repo])
  const [snapshot, setSnapshot] = useState<RepoSnapshot | null>(null)
  const [commits, setCommits] = useState<Commit[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT)
  const [view, setView] = useState<View>('history')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  const loaded = useRef(PAGE)
  const refsKey = useRef('')
  const [staleNotice, setStaleNotice] = useState(false)

  const dismissToast = useCallback((id: number) => {
    setToasts((items) => items.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback<RepoContextValue['toast']>((kind, text, action) => {
    const id = ++toastId.current
    setToasts((items) => [...items.slice(-3), { id, kind, text, action }])
    if (kind !== 'error') setTimeout(() => dismissToast(id), action ? 10000 : 5000)
  }, [dismissToast])

  const reload = useCallback(async () => {
    const [nextSnapshot, nextCommits] = await Promise.all([
      client.snapshot(),
      client.readLog({ limit: loaded.current + 1 })
    ])
    setSnapshot(nextSnapshot)
    setHasMore(nextCommits.length > loaded.current)
    setCommits(nextCommits.slice(0, loaded.current))
    refsKey.current = keyOfRefs(nextSnapshot)
    const known = new Set(nextCommits.map((commit) => commit.sha))
    setSelected((shas) => shas.filter((sha) => known.has(sha)))
    // Refs can move outside the app. A draft built on commits that moved would apply to the wrong state.
    setDraftState((current) => {
      const edits = Object.fromEntries(Object.entries(current.edits).filter(([sha]) => known.has(sha)))
      const sequence = current.sequence
      const branch = sequence && nextSnapshot.refs.find((ref) => ref.kind === 'branch' && ref.name === sequence.branch)
      const sequenceValid = !sequence || branch?.sha === sequence.tip
      const editsValid = Object.keys(edits).length === Object.keys(current.edits).length
      if (sequenceValid && editsValid) return current
      setStaleNotice(true)
      return { edits, sequence: sequenceValid ? sequence : null }
    })
  }, [client])

  const loadMore = useCallback(async () => {
    loaded.current += PAGE
    await reload()
  }, [reload])

  const run = useCallback<RepoContextValue['run']>(async (label, action) => {
    setBusy(label)
    try {
      return await action()
    } catch (error) {
      toast('error', (error as Error).message)
      return undefined
    } finally {
      // The spinner stays until the list is fresh, so nothing can be clicked on stale rows.
      await reload().catch((error: Error) => toast('error', error.message))
      setBusy(null)
    }
  }, [reload, toast])

  useEffect(() => {
    void reload().catch((error: Error) => toast('error', error.message))
    const refresh = (): void => {
      void client.snapshot().then((next) => {
        if (keyOfRefs(next) === refsKey.current) setSnapshot(next)
        else void reload()
      }).catch(() => {})
    }
    window.addEventListener('focus', refresh)
    const interval = setInterval(refresh, 5000)
    const unsubscribe = window.chronicle.onChanged((changed) => {
      if (changed === repo) void reload()
    })
    return () => {
      window.removeEventListener('focus', refresh)
      clearInterval(interval)
      unsubscribe()
    }
  }, [client, reload, repo, toast])

  useEffect(() => {
    if (!staleNotice) return
    setStaleNotice(false)
    toast('info', 'Ветки изменились вне приложения, поэтому часть черновика сброшена.')
  }, [staleNotice, toast])

  const setDraft = useCallback((update: (draft: Draft) => Draft) => setDraftState(update), [])
  const draftCount = useMemo(() => draftChangeCount(commits, draft), [commits, draft])

  const value: RepoContextValue = {
    repo, client, snapshot, commits, hasMore, loadMore, reload, draft, setDraft, draftCount,
    view, setView, selected, setSelected, busy, run, toast, toasts, dismissToast, closeRepo: onClose
  }
  return <RepoContext.Provider value={value}>{children}</RepoContext.Provider>
}
