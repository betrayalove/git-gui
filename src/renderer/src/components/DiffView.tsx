import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { splitRows } from '../../../shared/diff-rows'
import { imageType } from '../../../shared/images'
import type { DiffLine, DiffResult, DiffSource, FileDiff, FileState, ImageVersions } from '../../../shared/types'
import { setDiffPreferences, useDiffPreferences } from '../diff-prefs'
import { useRepo } from '../store'
import { grammarFor, highlightLines, type Segment } from '../syntax'
import { Icon } from './ui'
import { plural, t } from '../../../shared/i18n'

const MAX_LINES_PER_FILE = 1500

export interface DiffActions {
  /** Controls shown on a hunk's header row, given the chosen lines of that hunk as indexes into `hunk.lines`. */
  hunk?: (file: FileDiff, hunkIndex: number, lines: number[]) => ReactNode
  /** Controls shown on a file's header row. */
  file?: (file: FileDiff) => ReactNode
  /** Whether single changed lines of the file can be chosen. */
  lines?: (file: FileDiff) => boolean
}

const STATUS_NAME: Partial<Record<FileState, string>> = {
  added: t('Добавлен'),
  modified: t('Изменён'),
  deleted: t('Удалён'),
  renamed: t('Переименован'),
  copied: t('Скопирован'),
  typechange: t('Сменился тип')
}

/** Whether a changed line of the file contains the searched text. */
function hasMatch(file: FileDiff, term?: string): boolean {
  if (!term) return false
  const needle = term.toLowerCase()
  return file.hunks.some((hunk) => hunk.lines.some((line) => line.type !== 'context' && line.text.toLowerCase().includes(needle)))
}

/** How many files changed in each way, and how many lines were added and removed in all. */
function Summary({ files }: { files: FileDiff[] }): ReactNode {
  const count = (status: FileState): number => files.filter((file) => file.status === status).length
  const parts = [
    [count('added'), t('добавлено: {count}', { count: count('added') })],
    [count('modified') + count('typechange'), t('изменено: {count}', { count: count('modified') + count('typechange') })],
    [count('deleted'), t('удалено: {count}', { count: count('deleted') })],
    [count('renamed') + count('copied'), t('переименовано: {count}', { count: count('renamed') + count('copied') })]
  ] as const
  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return (
    <div className="diff-summary">
      <b>{plural(files.length, 'файл', 'файла', 'файлов')}</b>
      <span className="muted">{parts.filter(([amount]) => amount > 0).map(([, text]) => text).join(', ')}</span>
      <span className="diff-stat">
        <span className="add">+{additions}</span>
        <span className="del">−{deletions}</span>
      </span>
    </div>
  )
}

/** Where `term` occurs in the text, ignoring case, as [start, end) ranges. */
function matchRanges(text: string, term?: string): [number, number][] {
  if (!term) return []
  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  const ranges: [number, number][] = []
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) ranges.push([at, at + needle.length])
  return ranges
}

/** A line's text in its syntax colours, with every occurrence of the searched text marked. */
function LineText({ text, segments, term }: { text: string; segments?: Segment[]; term?: string }): ReactNode {
  const ranges = matchRanges(text, term)
  if (!segments && !ranges.length) return text
  const parts: ReactNode[] = []
  let offset = 0
  for (const segment of segments ?? [{ text }]) {
    const end = offset + segment.text.length
    // Cut the piece wherever a match starts or ends inside it.
    const cuts = [offset, ...ranges.flat().filter((cut) => cut > offset && cut < end), end]
    for (let index = 0; index < cuts.length - 1; index++) {
      const piece = text.slice(cuts[index], cuts[index + 1])
      const marked = ranges.some(([start, stop]) => cuts[index] >= start && cuts[index] < stop)
      const key = `${cuts[index]}`
      const colored = segment.kind ? <span key={key} className={`tok-${segment.kind}`}>{piece}</span> : piece
      parts.push(marked ? <mark key={key}>{colored}</mark> : colored)
    }
    offset = end
  }
  return parts
}

/** Syntax colours for every line of the file, per hunk; undefined where the language is unknown or the text too long. */
function useSyntax(file: FileDiff): (Segment[] | undefined)[][] | null {
  return useMemo(() => {
    const grammar = file.binary ? null : grammarFor(file.path)
    if (!grammar) return null
    return file.hunks.map((hunk) => {
      // Each side is read as a whole, so text spanning lines is coloured the way it is in that version.
      const oldSide = hunk.lines.flatMap((line, index) => (line.type === 'context' || line.type === 'del' ? [index] : []))
      const newSide = hunk.lines.flatMap((line, index) => (line.type === 'context' || line.type === 'add' ? [index] : []))
      const result: (Segment[] | undefined)[] = []
      const fill = (indexes: number[]): void => {
        const colored = highlightLines(indexes.map((index) => hunk.lines[index].text), grammar)
        indexes.forEach((lineIndex, position) => { result[lineIndex] = colored?.[position] })
      }
      fill(oldSide)
      fill(newSide)
      return result
    })
  }, [file])
}

function ImageDiff({ file, source }: { file: FileDiff; source: DiffSource }): ReactNode {
  const { client } = useRepo()
  const [versions, setVersions] = useState<ImageVersions | null>(null)
  const [failed, setFailed] = useState(false)
  // Callers build the source anew on every render; only a different place should read again.
  const sourceKey = JSON.stringify(source)
  useEffect(() => {
    let cancelled = false
    client.readImageVersions(JSON.parse(sourceKey) as DiffSource, file.path, file.oldPath)
      .then((result) => { if (!cancelled) setVersions(result) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [client, sourceKey, file])
  if (failed) return <div className="diff-note">{t('Бинарный файл')}</div>
  if (!versions) return <div className="diff-loading">{t('Загружаю картинку…')}</div>
  if (versions.tooLarge) return <div className="diff-note">{t('Картинка слишком большая, чтобы её показать.')}</div>
  return (
    <div className="image-diff">
      <ImageSide title={t('Было')} url={versions.before} kind="del" />
      <ImageSide title={t('Стало')} url={versions.after} kind="add" />
    </div>
  )
}

function ImageSide({ title, url, kind }: { title: string; url: string | null; kind: 'add' | 'del' }): ReactNode {
  const [size, setSize] = useState<string | null>(null)
  return (
    <figure className={`image-side ${kind}`}>
      <figcaption>{title}{size && <span className="muted"> · {size}</span>}</figcaption>
      {url
        ? <div className="image-frame"><img src={url} alt={title} onLoad={(event) => setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} /></div>
        : <div className="image-frame image-missing">{kind === 'del' ? t('Файла не было') : t('Файл удалён')}</div>}
    </figure>
  )
}

interface Chosen {
  /** The diff the choice belongs to; a fresh diff starts with nothing chosen. */
  file: FileDiff
  lines: Record<number, number[]>
  anchor: { hunk: number; line: number } | null
}

const isChange = (line: DiffLine): boolean => line.type === 'add' || line.type === 'del'
const MARK: Record<DiffLine['type'], string> = { add: '+', del: '−', context: '', note: '' }

function FileBlock({ file, defaultOpen, actions, highlight, split, source, whitespaceHidden }: {
  file: FileDiff
  defaultOpen: boolean
  actions?: DiffActions
  highlight?: string
  split: boolean
  source?: DiffSource
  whitespaceHidden: boolean
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)
  const [chosenState, setChosen] = useState<Chosen | null>(null)
  const syntax = useSyntax(file)
  const chosen = chosenState?.file === file ? chosenState : { file, lines: {}, anchor: null }
  const pickable = Boolean(actions?.lines?.(file))
  const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  let shown = 0

  const toggle = (hunkIndex: number, lineIndex: number, event: MouseEvent): void => {
    // Dragging across lines to copy them should not change the choice.
    if (window.getSelection()?.toString()) return
    const current = new Set(chosen.lines[hunkIndex] ?? [])
    const anchor = chosen.anchor
    if (event.shiftKey && anchor?.hunk === hunkIndex) {
      const [from, to] = anchor.line < lineIndex ? [anchor.line, lineIndex] : [lineIndex, anchor.line]
      const lines = file.hunks[hunkIndex].lines
      for (let index = from; index <= to; index++) if (isChange(lines[index])) current.add(index)
    } else if (current.has(lineIndex)) {
      current.delete(lineIndex)
    } else {
      current.add(lineIndex)
    }
    setChosen({ file, lines: { ...chosen.lines, [hunkIndex]: [...current].sort((a, b) => a - b) }, anchor: { hunk: hunkIndex, line: lineIndex } })
  }

  const lineProps = (line: DiffLine, hunkIndex: number, lineIndex: number): { className: string; role?: string; 'aria-checked'?: boolean; onClick?: (event: MouseEvent) => void } => {
    if (!pickable || !isChange(line)) return { className: '' }
    const picked = chosen.lines[hunkIndex]?.includes(lineIndex) ?? false
    return {
      className: `pickable ${picked ? 'picked' : ''}`,
      role: 'checkbox',
      'aria-checked': picked,
      onClick: (event) => toggle(hunkIndex, lineIndex, event)
    }
  }

  const text = (hunkIndex: number, lineIndex: number, line: DiffLine): ReactNode =>
    <LineText text={line.text} segments={syntax?.[hunkIndex][lineIndex]} term={line.type === 'context' ? undefined : highlight} />

  const unifiedLines = (hunkIndex: number): ReactNode => file.hunks[hunkIndex].lines.map((line, lineIndex) => {
    if (!showAll && shown++ >= MAX_LINES_PER_FILE) return null
    const { className, ...pick } = lineProps(line, hunkIndex, lineIndex)
    return (
      <div key={lineIndex} className={`diff-line ${line.type} ${className}`} {...pick}>
        <span className="ln">{line.oldNo ?? ''}</span>
        <span className="ln">{line.newNo ?? ''}</span>
        <span className="mark">{MARK[line.type]}</span>
        <code>{text(hunkIndex, lineIndex, line)}</code>
      </div>
    )
  })

  const splitCell = (hunkIndex: number, lineIndex: number | undefined, side: 'old' | 'new'): ReactNode => {
    if (lineIndex === undefined) return <div className="split-cell split-blank" />
    const line = file.hunks[hunkIndex].lines[lineIndex]
    const { className, ...pick } = lineProps(line, hunkIndex, lineIndex)
    return (
      <div className={`split-cell diff-line ${line.type} ${className}`} {...pick}>
        <span className="ln">{(side === 'old' ? line.oldNo : line.newNo) ?? ''}</span>
        <span className="mark">{MARK[line.type]}</span>
        <code>{text(hunkIndex, lineIndex, line)}</code>
      </div>
    )
  }

  const splitLines = (hunkIndex: number): ReactNode => splitRows(file.hunks[hunkIndex]).map((row, rowIndex) => {
    if (!showAll && shown++ >= MAX_LINES_PER_FILE) return null
    return (
      <div key={rowIndex} className="split-row">
        {splitCell(hunkIndex, row.left, 'old')}
        {splitCell(hunkIndex, row.right, 'new')}
      </div>
    )
  })

  const image = file.binary && source && imageType(file.path)
  return (
    <section className="diff-file">
      {actions?.file && <div className="diff-file-action">{actions.file(file)}</div>}
      <button className="diff-file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        <span className={`file-badge file-${file.status}`} title={STATUS_NAME[file.status]}>{file.status[0].toUpperCase()}</span>
        <span className="diff-path" title={file.path}>
          {file.oldPath && <span className="diff-old">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="diff-stat">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <div className={`diff-body ${split ? 'split' : ''}`}>
          {image && <ImageDiff file={file} source={source} />}
          {file.binary && !image && <div className="diff-note">{t('Бинарный файл')}</div>}
          {!file.binary && !file.hunks.length && (
            <div className="diff-note">{whitespaceHidden ? t('Отличаются только пробелы') : t('Нет изменений в содержимом')}</div>
          )}
          {file.hunks.map((hunk, hunkIndex) => {
            if (!showAll && shown >= MAX_LINES_PER_FILE) return null
            const picked = chosen.lines[hunkIndex] ?? []
            return (
              <div key={hunkIndex}>
                <div className="hunk-head">
                  <span>{hunk.header}</span>
                  <span className="hunk-actions">
                    {picked.length > 0 && (
                      <button className="btn btn-small btn-ghost" onClick={() => setChosen({ ...chosen, lines: { ...chosen.lines, [hunkIndex]: [] } })}>
                        {t('Снять выбор')}
                      </button>
                    )}
                    {actions?.hunk?.(file, hunkIndex, picked)}
                  </span>
                </div>
                {split ? splitLines(hunkIndex) : unifiedLines(hunkIndex)}
              </div>
            )
          })}
          {!showAll && total > MAX_LINES_PER_FILE && (
            <button className="btn btn-ghost diff-more" onClick={() => setShowAll(true)}>
              {t('Показать все строки:')} {total}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** The choice between one and two columns, and, where the caller reads the diff again for it, hiding whitespace. */
function DiffToolbar({ whitespace }: { whitespace: boolean }): ReactNode {
  const preferences = useDiffPreferences()
  return (
    <div className="diff-toolbar">
      <div className="segmented compact" role="group" aria-label={t('Вид изменений')}>
        <button className={preferences.split ? '' : 'active'} aria-pressed={!preferences.split} onClick={() => setDiffPreferences({ split: false })}>{t('Одна колонка')}</button>
        <button className={preferences.split ? 'active' : ''} aria-pressed={preferences.split} onClick={() => setDiffPreferences({ split: true })}>{t('Две колонки')}</button>
      </div>
      {whitespace && (
        <label className="check">
          <input type="checkbox" checked={preferences.ignoreWhitespace} onChange={(event) => setDiffPreferences({ ignoreWhitespace: event.target.checked })} />
          <span>{t('Без пробелов')}</span>
        </label>
      )}
    </div>
  )
}

/**
 * Shows changed files. With `collapsed` the files start closed under a summary, so a commit opens
 * as a list of what changed; a file that holds the searched text still opens by itself.
 * `source` lets changed images be shown; `whitespace` offers hiding whitespace changes, which the
 * caller then has to read the diff again for, using `useDiffPreferences().ignoreWhitespace`.
 */
export function DiffView({ diff, actions, highlight, collapsed = false, source, whitespace = false }: {
  diff: DiffResult | null
  actions?: DiffActions
  highlight?: string
  collapsed?: boolean
  source?: DiffSource
  whitespace?: boolean
}): ReactNode {
  const preferences = useDiffPreferences()
  if (!diff) return <div className="diff-loading">{t('Загружаю изменения…')}</div>
  const toolbar = <DiffToolbar whitespace={whitespace} />
  if (!diff.files.length) return <div className="diff">{whitespace && preferences.ignoreWhitespace && toolbar}<div className="diff-note">{t('Изменений нет')}</div></div>
  return (
    <div className="diff">
      {toolbar}
      {diff.truncated && <div className="banner warn">{t('Изменения слишком большие и показаны не полностью.')}</div>}
      {collapsed && <Summary files={diff.files} />}
      {diff.files.map((file, index) => (
        <FileBlock
          key={`${file.path}-${index}`}
          file={file}
          defaultOpen={collapsed ? hasMatch(file, highlight) : diff.files.length <= 20}
          actions={actions}
          highlight={highlight}
          split={preferences.split}
          source={source}
          whitespaceHidden={whitespace && preferences.ignoreWhitespace}
        />
      ))}
    </div>
  )
}
