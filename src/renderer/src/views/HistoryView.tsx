import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import {
  applyDraftToCommits, isSequenceChanged, linearChain, moveInSequence, setAction, setSplit, squashInSequence, startSequence,
  type DisplayCommit, type DraftSequence, type RowDraftState
} from '../../../shared/draft'
import { clampRow, layoutGraph } from '../../../shared/graph'
import type { RefInfo, TodoAction, TodoItem } from '../../../shared/types'
import { appApi } from '../api'
import { ConfirmDialog, PromptDialog, ScheduleDialog, SplitCommitDialog, useDialogs } from '../components/dialogs'
import { GraphCell, graphWidth, ROW_HEIGHT } from '../components/Graph'
import { Avatar, ContextMenu, EmptyState, Icon, type MenuItem } from '../components/ui'
import { formatFull, formatRelative, shortSha } from '../format'
import { useRepo } from '../store'

const OVERSCAN = 12
const MAX_LANES = 12
const MAX_CHIPS = 3

const STATE_LABEL: Record<RowDraftState, string> = {
  edited: 'изменён',
  moved: 'перемещён',
  dropped: 'удалён',
  squashed: 'объединён',
  fixup: 'объединён',
  split: 'разделён'
}

function RefChip({ info }: { info: RefInfo }): ReactNode {
  const icon = info.kind === 'tag' ? 'tag' : info.kind === 'remote' ? 'cloud' : 'branch'
  return (
    <span className={`ref-chip ref-${info.kind} ${info.isHead ? 'ref-head' : ''}`} title={info.ref}>
      <Icon name={icon} size={11} /><span className="truncate">{info.name}</span>
    </span>
  )
}

interface DropTarget {
  sha: string
  zone: 'above' | 'below' | 'onto'
}

const SEARCH_DELAY_MS = 350

export function HistoryView(): ReactNode {
  const { commits, snapshot, draft, setDraft, selected, setSelected, hasMore, loadMore, client, run, toast, search, searchMode, focus } = useRepo()
  const { show } = useDialogs()
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(800)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const anchor = useRef<string | null>(null)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const display = useMemo(() => applyDraftToCommits(commits, draft), [commits, draft])
  const query = search.trim().toLowerCase()
  const [matches, setMatches] = useState<{ shas: Set<string>; limited: boolean } | null>(null)
  const contentQuery = searchMode === 'content' ? query : ''
  useEffect(() => {
    setMatches(null)
    if (!contentQuery) return
    let cancelled = false
    // Searching changes reads every diff, so it waits until typing pauses.
    const timer = setTimeout(() => {
      client.searchChanges({ text: contentQuery })
        .then((result) => { if (!cancelled) setMatches({ shas: new Set(result.shas), limited: result.limited }) })
        .catch((error: Error) => { if (!cancelled) toast('error', error.message) })
    }, SEARCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client, contentQuery, toast])
  const filtered = useMemo<DisplayCommit[]>(() => {
    if (!query) return display
    if (searchMode === 'content') return matches ? display.filter((commit) => matches.shas.has(commit.sha)) : []
    return display.filter((commit) =>
      commit.message.toLowerCase().includes(query) ||
      commit.authorName.toLowerCase().includes(query) ||
      commit.authorEmail.toLowerCase().includes(query) ||
      commit.sha.startsWith(query)
    )
  }, [display, matches, query, searchMode])
  const unloaded = matches ? matches.shas.size - filtered.length : 0

  useEffect(() => {
    if (!focus || !scroller.current) return
    const index = filtered.findIndex((commit) => commit.sha === focus.sha)
    if (index === -1) {
      toast('info', 'Этот коммит дальше загруженной истории. Загрузи её внизу списка.')
      return
    }
    const element = scroller.current
    const top = index * ROW_HEIGHT
    if (top < element.scrollTop || top > element.scrollTop + element.clientHeight - ROW_HEIGHT) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 3)
    }
    // Only a new request should scroll, not every change to the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])
  const rows = useMemo(() => (query ? [] : layoutGraph(display).map((row) => clampRow(row, MAX_LANES))), [display, query])

  const refsBySha = useMemo(() => {
    const map = new Map<string, RefInfo[]>()
    const sequence = draft.sequence
    const moved = sequence && isSequenceChanged(commits, sequence) ? sequence : null
    const newTop = moved ? [...moved.todo].reverse().find((item) => item.action !== 'drop')?.sha ?? moved.tip : null
    for (const ref of snapshot?.refs ?? []) {
      const isLocal = ref.kind !== 'remote'
      const target = moved && isLocal && ref.target === moved.tip ? newTop! : ref.target
      const list = map.get(target) ?? []
      list.push(ref)
      map.set(target, list)
    }
    for (const list of map.values()) {
      const rank = (ref: RefInfo): number => (ref.isHead ? 0 : ref.kind === 'branch' ? 1 : ref.kind === 'remote' ? 2 : 3)
      list.sort((a, b) => rank(a) - rank(b))
    }
    return map
  }, [commits, draft.sequence, snapshot?.refs])

  /** The editable run containing a commit, preferring the checked-out branch. */
  const sequenceFor = (sha: string): DraftSequence | null => {
    if (draft.sequence?.todo.some((item) => item.sha === sha)) return draft.sequence
    if (draft.sequence && isSequenceChanged(commits, draft.sequence)) {
      toast('info', `В черновике уже перестраивается ветка ${draft.sequence.branch}. Сначала примени или сбрось её.`)
      return null
    }
    const branches = (snapshot?.refs ?? [])
      .filter((ref) => ref.kind === 'branch')
      .sort((a, b) => Number(b.isHead ?? false) - Number(a.isHead ?? false))
    for (const branch of branches) {
      if (linearChain(commits, branch.sha)?.chain.includes(sha)) return startSequence(commits, branch.name, branch.sha)
    }
    toast('info', 'Этот коммит нельзя переставлять: он не входит в линейный участок локальной ветки.')
    return null
  }

  /** The run a commit would be edited in, without side effects or messages. */
  const sequenceRunOf = (sha: string): TodoItem[] | null => {
    const branches = (snapshot?.refs ?? []).filter((ref) => ref.kind === 'branch')
    for (const branch of branches) {
      const run = linearChain(commits, branch.sha)
      if (run?.chain.includes(sha)) return run.chain.map((item) => ({ sha: item, action: 'pick' }))
    }
    return null
  }

  const changeSequence = (sha: string, change: (sequence: DraftSequence) => DraftSequence): void => {
    const sequence = sequenceFor(sha)
    if (sequence) setDraft((current) => ({ ...current, sequence: change(sequence) }))
  }

  const actionFor = (sha: string): TodoAction | undefined => draft.sequence?.todo.find((item) => item.sha === sha)?.action

  const onRowClick = (event: MouseEvent, sha: string, index: number): void => {
    if (event.shiftKey && anchor.current) {
      const start = filtered.findIndex((commit) => commit.sha === anchor.current)
      const [from, to] = start < index ? [start, index] : [index, start]
      setSelected(filtered.slice(from, to + 1).map((commit) => commit.sha))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      setSelected(selected.includes(sha) ? selected.filter((item) => item !== sha) : [...selected, sha])
    } else {
      setSelected([sha])
    }
    anchor.current = sha
  }

  const onDragOver = (event: DragEvent, sha: string): void => {
    if (!dragging || dragging === sha) return
    const sequence = draft.sequence
    if (!sequence?.todo.some((item) => item.sha === sha)) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - box.top) / box.height
    const zone = ratio < 0.28 ? 'above' : ratio > 0.72 ? 'below' : 'onto'
    if (dropTarget?.sha !== sha || dropTarget.zone !== zone) setDropTarget({ sha, zone })
  }

  const onDrop = (event: DragEvent): void => {
    event.preventDefault()
    if (dragging && dropTarget) {
      const { sha, zone } = dropTarget
      changeSequence(dragging, (sequence) =>
        zone === 'onto' ? squashInSequence(sequence, dragging, sha, 'squash') : moveInSequence(sequence, dragging, sha, zone)
      )
    }
    setDragging(null)
    setDropTarget(null)
  }

  const openMenu = (event: MouseEvent, commit: DisplayCommit): void => {
    event.preventDefault()
    if (!selected.includes(commit.sha)) setSelected([commit.sha])
    const head = snapshot?.status.head
    const headRef = snapshot?.refs.find((ref) => ref.kind === 'branch' && ref.name === head)
    const headChain = headRef ? linearChain(commits, headRef.sha)?.chain ?? [] : []
    const headIndex = headChain.indexOf(commit.sha)
    const action = actionFor(commit.sha)
    // Melding needs a surviving commit below this one in the run it belongs to.
    const editableRun = draft.sequence?.todo.some((item) => item.sha === commit.sha)
      ? draft.sequence.todo
      : (sequenceRunOf(commit.sha) ?? [])
    const position = editableRun.findIndex((item) => item.sha === commit.sha)
    const canMeld = position > 0 && editableRun.slice(0, position).some((item) => item.action !== 'drop')
    const items: MenuItem[] = [
      {
        label: action === 'drop' ? 'Вернуть коммит' : 'Удалить из истории',
        icon: 'trash',
        danger: action !== 'drop',
        run: () => changeSequence(commit.sha, (sequence) => setAction(sequence, commit.sha, action === 'drop' ? 'pick' : 'drop'))
      },
      {
        label: 'Объединить с предыдущим',
        icon: 'branch',
        disabled: !canMeld,
        run: () => changeSequence(commit.sha, (sequence) => setAction(sequence, commit.sha, 'squash'))
      },
      {
        label: 'Объединить, отбросив сообщение',
        disabled: !canMeld,
        run: () => changeSequence(commit.sha, (sequence) => setAction(sequence, commit.sha, 'fixup'))
      },
      ...(action === 'squash' || action === 'fixup' ? [{
        label: 'Отменить объединение',
        run: () => changeSequence(commit.sha, (sequence) => setAction(sequence, commit.sha, 'pick'))
      }] : []),
      commit.draftStates.includes('split') ? {
        label: 'Отменить разделение',
        icon: 'split',
        run: () => changeSequence(commit.sha, (sequence) => setSplit(sequence, commit.sha, undefined))
      } : {
        label: 'Разделить коммит…',
        icon: 'split',
        disabled: commit.parents.length > 1 || !editableRun.length,
        run: () => show(<SplitCommitDialog
          commit={commit}
          onConfirm={(split, secondMessage) => {
            changeSequence(commit.sha, (sequence) => setSplit(sequence, commit.sha, split))
            if (secondMessage !== commit.message) {
              setDraft((current) => ({
                ...current,
                edits: { ...current.edits, [commit.sha]: { ...current.edits[commit.sha], message: secondMessage } }
              }))
            }
          }}
        />)
      },
      { separator: true },
      {
        label: headIndex >= 0 ? `Снять ${headChain.length - headIndex} и опубликовать позже…` : 'Снять и опубликовать позже…',
        icon: 'schedule',
        disabled: headIndex < 0 || commit.parents.length !== 1,
        run: () => show(<ScheduleDialog branch={head!} count={headChain.length - headIndex} />)
      },
      { separator: true },
      {
        label: 'Создать ветку здесь…',
        icon: 'branch',
        run: () => show(<PromptDialog title="Новая ветка" label="Имя ветки" confirmLabel="Создать и перейти" onSubmit={(name) => {
          void run('Создаю ветку', () => client.createBranch(name, commit.sha, true))
        }} />)
      },
      {
        label: 'Создать тег здесь…',
        icon: 'tag',
        run: () => show(<PromptDialog title="Новый тег" label="Имя тега" confirmLabel="Создать" onSubmit={(name) => {
          void run('Создаю тег', () => client.createTag(name, commit.sha))
        }} />)
      },
      { label: 'Перейти на этот коммит', run: () => void run('Переключаюсь', () => client.checkoutCommit(commit.sha)) },
      { label: 'Cherry-pick в текущую ветку', run: () => void run('Cherry-pick', () => client.cherryPick(commit.sha)) },
      { label: 'Создать обратный коммит (revert)', run: () => void run('Revert', () => client.revertCommit(commit.sha)) },
      {
        label: 'Сбросить ветку сюда…',
        danger: true,
        run: () => show(<ConfirmDialog
          title="Сбросить ветку"
          danger
          confirmLabel="Сбросить, потеряв правки"
          body={<>Ветка <b>{head ?? 'HEAD'}</b> встанет на <code>{shortSha(commit.sha)}</code>. Незакоммиченные правки будут потеряны. Коммиты можно найти через reflog.</>}
          onConfirm={() => void run('Сбрасываю', () => client.resetTo(commit.sha, 'hard'))}
        />)
      },
      { separator: true },
      { label: 'Копировать SHA', run: () => void appApi.copyText(commit.sha) }
    ]
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  if (!commits.length) {
    return <EmptyState icon="history" title="Коммитов пока нет">Создай первый коммит на вкладке «Изменения».</EmptyState>
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(filtered.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  // The graph takes only what the rows around the viewport need, so one busy stretch of history
  // does not squeeze every commit message elsewhere.
  const visibleColumns = rows.slice(first, last).reduce((max, row) => Math.max(max, row.width), 1)
  const width = query ? 0 : graphWidth(visibleColumns)
  const indexBySha = query ? null : new Map(display.map((commit, index) => [commit.sha, index]))

  return (
    <div className="history">
      <div className="history-head" style={{ paddingLeft: width + 26 }}>
        <span className="col-subject">Сообщение</span>
        <span className="col-author">Автор</span>
        <span className="col-date">Дата</span>
        <span className="col-sha">SHA</span>
      </div>
      <div
        className="history-scroll"
        ref={scroller}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: filtered.length * ROW_HEIGHT, position: 'relative' }}>
          {filtered.slice(first, last).map((commit, offset) => {
            const index = first + offset
            const row = indexBySha ? rows[indexBySha.get(commit.sha)!] : null
            const refs = refsBySha.get(commit.sha) ?? []
            const isSelected = selected.includes(commit.sha)
            const dropped = commit.draftStates.includes('dropped')
            const melded = commit.draftStates.includes('squashed') || commit.draftStates.includes('fixup')
            const target = dropTarget?.sha === commit.sha ? dropTarget.zone : null
            return (
              <div
                key={commit.sha}
                className={[
                  'commit-row',
                  isSelected ? 'selected' : '',
                  dropped ? 'dropped' : '',
                  melded ? 'melded' : '',
                  commit.draftStates.length ? 'drafted' : '',
                  dragging === commit.sha ? 'dragging' : '',
                  target ? `drop-${target}` : ''
                ].join(' ')}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                draggable={!query && commit.parents.length <= 1}
                onDragStart={(event) => {
                  const sequence = sequenceFor(commit.sha)
                  if (!sequence) {
                    event.preventDefault()
                    return
                  }
                  if (draft.sequence !== sequence) setDraft((current) => ({ ...current, sequence }))
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', commit.sha)
                  setDragging(commit.sha)
                }}
                onDragEnd={() => { setDragging(null); setDropTarget(null) }}
                onDragOver={(event) => onDragOver(event, commit.sha)}
                onDrop={onDrop}
                onClick={(event) => onRowClick(event, commit.sha, index)}
                onContextMenu={(event) => openMenu(event, commit)}
              >
                <span className="grip"><Icon name="grip" size={14} /></span>
                {row && <GraphCell row={row} width={width} merge={commit.parents.length > 1} ghost={dropped} />}
                <span className="col-subject">
                  {refs.length > 0 && (
                    <span className="ref-chips">
                      {refs.slice(0, MAX_CHIPS).map((ref) => <RefChip key={ref.ref} info={ref} />)}
                      {refs.length > MAX_CHIPS && (
                        <span className="ref-chip ref-more" title={refs.slice(MAX_CHIPS).map((ref) => ref.name).join(', ')}>+{refs.length - MAX_CHIPS}</span>
                      )}
                    </span>
                  )}
                  <span className="subject truncate" title={commit.message}>{commit.subject}</span>
                  {commit.draftStates.map((state) => <span key={state} className={`state-pill state-${state}`}>{STATE_LABEL[state]}</span>)}
                </span>
                <span className="col-author">
                  <Avatar name={commit.authorName} email={commit.authorEmail} size={20} />
                  <span className="truncate">{commit.authorName}</span>
                </span>
                <span className="col-date" title={formatFull(commit.authorDate)}>{formatRelative(commit.authorDate)}</span>
                <code className="col-sha">{shortSha(commit.sha)}</code>
              </div>
            )
          })}
        </div>
        {hasMore && !query && (
          <div className="load-more"><button className="btn btn-ghost" onClick={() => void loadMore()}>Загрузить ещё</button></div>
        )}
        {query && searchMode === 'content' && !matches && <div className="diff-loading">Ищу в изменениях…</div>}
        {query && (searchMode === 'message' || matches) && !filtered.length && !unloaded && (
          <EmptyState icon="search" title="Ничего не найдено">
            {searchMode === 'content' ? 'Ни один коммит не добавлял и не удалял строку с этим текстом.' : 'Поиск идёт по сообщению, автору и SHA. Чтобы искать в изменённых строках, нажми { } в поле поиска.'}
          </EmptyState>
        )}
        {(unloaded > 0 || matches?.limited) && (
          <div className="load-more">
            {unloaded > 0 && <span className="muted">Ещё найдено в незагруженной истории: {unloaded}. </span>}
            {matches?.limited && <span className="muted">Показаны первые совпадения, уточни запрос. </span>}
            {hasMore && <button className="btn btn-ghost" onClick={() => void loadMore()}>Загрузить ещё</button>}
          </div>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
