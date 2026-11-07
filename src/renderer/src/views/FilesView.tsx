import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { BlameResult, DiffResult, FileVersion } from '../../../shared/types'
import { DiffView } from '../components/DiffView'
import { Avatar, EmptyState, Icon } from '../components/ui'
import { formatFull, formatRelative, shortSha } from '../format'
import { useRepo } from '../store'

const LIST_LIMIT = 400
const BLAME_RENDER_LIMIT = 4000
const STATUS_TEXT: Partial<Record<FileVersion['status'], string>> = {
  added: 'создан', deleted: 'удалён', renamed: 'переименован', copied: 'скопирован'
}

/** Newer changes get a stronger mark, so fresh edits stand out in a file. */
function ageShade(dates: string[]): (date: string) => number {
  const times = [...new Set(dates.map((date) => Date.parse(date)))].sort((a, b) => a - b)
  return (date) => (times.length < 2 ? 1 : times.indexOf(Date.parse(date)) / (times.length - 1))
}

function FileHistoryTab({ path, onBlame }: { path: string; onBlame: (rev: string, label: string) => void }): ReactNode {
  const { client, jumpTo } = useRepo()
  const [versions, setVersions] = useState<FileVersion[] | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffResult | null>(null)
  const version = versions?.find((item) => item.commit.sha === active) ?? versions?.[0]

  useEffect(() => {
    let cancelled = false
    client.fileHistory(path)
      .then((result) => { if (!cancelled) setVersions(result) })
      .catch(() => { if (!cancelled) setVersions([]) })
    return () => { cancelled = true }
  }, [client, path])

  useEffect(() => {
    if (!version) return
    let cancelled = false
    setDiff(null)
    client.commitDiff(version.commit.sha)
      .then((result) => {
        if (cancelled) return
        const files = result.files.filter((file) => file.path === version.path || file.oldPath === version.path)
        setDiff({ files, truncated: result.truncated })
      })
      .catch(() => { if (!cancelled) setDiff({ files: [], truncated: false }) })
    return () => { cancelled = true }
  }, [client, version])

  if (!versions) return <div className="diff-loading">Читаю историю файла…</div>
  if (!versions.length) return <EmptyState icon="history" title="Истории нет">Файл ещё не был закоммичен.</EmptyState>
  return (
    <div className="file-history">
      <div className="file-versions" role="listbox" aria-label="Версии файла">
        {versions.map((item) => (
          <button
            key={item.commit.sha}
            role="option"
            aria-selected={item === version}
            className={`file-version ${item === version ? 'active' : ''}`}
            onClick={() => setActive(item.commit.sha)}
          >
            <Avatar name={item.commit.authorName} email={item.commit.authorEmail} size={20} />
            <span className="file-version-main">
              <b className="truncate">{item.commit.subject}</b>
              <span className="muted truncate">
                {item.commit.authorName} · {formatRelative(item.commit.authorDate)}
                {STATUS_TEXT[item.status] ? ` · ${STATUS_TEXT[item.status]}` : ''}
                {item.path !== path ? ` · ${item.path}` : ''}
              </span>
            </span>
            <code>{shortSha(item.commit.sha)}</code>
          </button>
        ))}
      </div>
      <div className="file-version-diff">
        {version && (
          <div className="file-version-actions">
            <button className="btn btn-small" onClick={() => jumpTo(version.commit.sha)}><Icon name="history" size={13} />Открыть в истории</button>
            {version.status !== 'deleted' && (
              <button className="btn btn-small" onClick={() => onBlame(version.commit.sha, shortSha(version.commit.sha))}>Кто менял строки в этой версии</button>
            )}
          </div>
        )}
        <DiffView diff={diff} />
      </div>
    </div>
  )
}

function BlameTab({ path, rev, label, onBlame }: { path: string; rev: string; label: string | null; onBlame: (rev: string, label: string | null) => void }): ReactNode {
  const { client, jumpTo } = useRepo()
  const [blame, setBlame] = useState<BlameResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    setBlame(null)
    setError(null)
    client.blameFile(path, rev)
      .then((result) => { if (!cancelled) setBlame(result) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [client, path, rev])

  const shade = useMemo(() => ageShade(Object.values(blame?.commits ?? {}).map((commit) => commit.authorDate)), [blame])
  const head = (
    <div className="blame-head">
      <span className="muted">{label ? `Версия ${label}` : 'Текущая версия'}</span>
      {label && <button className="link" onClick={() => onBlame('HEAD', null)}>Вернуться к текущей</button>}
    </div>
  )
  if (error) return <>{head}<div className="banner warn"><Icon name="warning" />В этой версии файла нет: {error.split('\n')[0]}</div></>
  if (!blame) return <>{head}<div className="diff-loading">Смотрю, кто менял строки…</div></>
  if (blame.skipped) {
    return <>{head}<EmptyState icon="changes" title={blame.skipped === 'binary' ? 'Бинарный файл' : 'Файл слишком большой'}>Построчная история для него не строится.</EmptyState></>
  }
  const lines = showAll ? blame.lines : blame.lines.slice(0, BLAME_RENDER_LIMIT)
  return (
    <>
      {head}
      <div className="blame" role="table" aria-label="Кто менял строки">
        {lines.map((line, index) => {
          const commit = blame.commits[line.sha]
          const startsRun = index === 0 || lines[index - 1].sha !== line.sha
          return (
            <div key={line.line} role="row" className={`blame-row ${startsRun ? 'run-start' : ''}`} style={{ '--age': shade(commit.authorDate) } as React.CSSProperties}>
              <span className="blame-who" role="cell">
                {startsRun && (
                  <>
                    <button className="blame-commit" title={`${commit.summary}\n${commit.authorName}, ${formatFull(commit.authorDate)}\nОткрыть в истории`} onClick={() => jumpTo(commit.sha)}>
                      <Avatar name={commit.authorName} email={commit.authorEmail} size={16} />
                      <span className="truncate">{commit.summary}</span>
                      <span className="muted">{formatRelative(commit.authorDate)}</span>
                    </button>
                    <button className="icon-btn blame-before" title="Как выглядела строка до этого коммита" aria-label="Версия до этого коммита" onClick={() => onBlame(`${commit.sha}^`, `до ${shortSha(commit.sha)}`)}>
                      <Icon name="undo" size={12} />
                    </button>
                  </>
                )}
              </span>
              <span className="blame-ln" role="cell">{line.line}</span>
              <code role="cell">{line.text}</code>
            </div>
          )
        })}
      </div>
      {!showAll && blame.lines.length > BLAME_RENDER_LIMIT && (
        <button className="btn btn-ghost diff-more" onClick={() => setShowAll(true)}>Показать все строки: {blame.lines.length}</button>
      )}
    </>
  )
}

function FilePane({ path }: { path: string }): ReactNode {
  const [tab, setTab] = useState<'history' | 'blame'>('history')
  const [blameAt, setBlameAt] = useState<{ rev: string; label: string | null }>({ rev: 'HEAD', label: null })
  const showBlame = (rev: string, label: string | null): void => {
    setBlameAt({ rev, label })
    setTab('blame')
  }
  return (
    <div className="file-pane">
      <header className="pane-head">
        <h2 className="truncate" title={path}>{path}</h2>
        <div className="segmented compact" role="tablist">
          <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>История</button>
          <button role="tab" aria-selected={tab === 'blame'} className={tab === 'blame' ? 'active' : ''} onClick={() => setTab('blame')}>Кто менял строки</button>
        </div>
      </header>
      <div className="file-pane-body">
        {tab === 'history'
          ? <FileHistoryTab path={path} onBlame={showBlame} />
          : <BlameTab path={path} rev={blameAt.rev} label={blameAt.label} onBlame={showBlame} />}
      </div>
    </div>
  )
}

export function FilesView(): ReactNode {
  const { client, snapshot, filePath, openFile } = useRepo()
  const [files, setFiles] = useState<string[] | null>(null)
  const [query, setQuery] = useState('')
  const headSha = snapshot?.status.headSha

  useEffect(() => {
    let cancelled = false
    client.listFiles()
      .then((list) => { if (!cancelled) setFiles(list) })
      .catch(() => { if (!cancelled) setFiles([]) })
    return () => { cancelled = true }
  }, [client, headSha])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => (files ?? []).filter((file) => file.toLowerCase().includes(needle)), [files, needle])
  return (
    <div className="files">
      <div className="files-side">
        <label className="search files-search">
          <Icon name="search" size={14} />
          <input autoFocus value={query} placeholder="Найти файл" aria-label="Найти файл" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="file-list">
          {shown.slice(0, LIST_LIMIT).map((file) => {
            const slash = file.lastIndexOf('/')
            return (
              <button key={file} className={`file-row file-pick ${file === filePath ? 'active' : ''}`} title={file} onClick={() => openFile(file)}>
                <Icon name="file" size={13} />
                <span className="file-path truncate"><b>{file.slice(slash + 1)}</b>{slash > 0 && <span className="muted"> {file.slice(0, slash)}</span>}</span>
              </button>
            )
          })}
          {shown.length > LIST_LIMIT && <p className="hint files-more">Показаны первые {LIST_LIMIT} из {shown.length}. Уточни поиск.</p>}
          {files && !shown.length && <p className="hint files-more">{files.length ? 'Ничего не найдено.' : 'В репозитории пока нет файлов.'}</p>}
        </div>
      </div>
      <main className="files-main">
        {filePath
          ? <FilePane key={filePath} path={filePath} />
          : <EmptyState icon="file" title="Выбери файл">Здесь видны все его изменения и кто последним менял каждую строку.</EmptyState>}
      </main>
    </div>
  )
}
