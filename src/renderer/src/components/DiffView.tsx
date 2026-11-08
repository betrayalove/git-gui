import { useState, type ReactNode } from 'react'
import type { DiffResult, FileDiff } from '../../../shared/types'
import { Icon } from './ui'
import { t } from '../../../shared/i18n'

const MAX_LINES_PER_FILE = 1500

export interface DiffActions {
  /** Controls shown on a hunk's header row. */
  hunk?: (file: FileDiff, hunkIndex: number) => ReactNode
  /** Controls shown on a file's header row. */
  file?: (file: FileDiff) => ReactNode
}

/** Marks every occurrence of `term`, ignoring case, the way the search found it. */
function Highlighted({ text, term }: { text: string; term?: string }): ReactNode {
  if (!term) return text
  const lower = text.toLowerCase()
  const needle = term.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  if (!parts.length) return text
  parts.push(text.slice(from))
  return parts
}

function FileBlock({ file, defaultOpen, actions, highlight }: { file: FileDiff; defaultOpen: boolean; actions?: DiffActions; highlight?: string }): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)
  const total = file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  let shown = 0
  return (
    <section className="diff-file">
      {actions?.file && <div className="diff-file-action">{actions.file(file)}</div>}
      <button className="diff-file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={12} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        <span className={`file-badge file-${file.status}`}>{file.status[0].toUpperCase()}</span>
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
        <div className="diff-body">
          {file.binary && <div className="diff-note">{t('Бинарный файл')}</div>}
          {!file.binary && !file.hunks.length && <div className="diff-note">{t('Нет изменений в содержимом')}</div>}
          {file.hunks.map((hunk, hunkIndex) => {
            if (!showAll && shown >= MAX_LINES_PER_FILE) return null
            return (
              <div key={hunkIndex}>
                <div className="hunk-head">
                  <span>{hunk.header}</span>
                  {actions?.hunk && <span className="hunk-actions">{actions.hunk(file, hunkIndex)}</span>}
                </div>
                {hunk.lines.map((line, lineIndex) => {
                  if (!showAll && shown++ >= MAX_LINES_PER_FILE) return null
                  return (
                    <div key={lineIndex} className={`diff-line ${line.type}`}>
                      <span className="ln">{line.oldNo ?? ''}</span>
                      <span className="ln">{line.newNo ?? ''}</span>
                      <span className="mark">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}</span>
                      <code><Highlighted text={line.text} term={line.type === 'context' ? undefined : highlight} /></code>
                    </div>
                  )
                })}
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

export function DiffView({ diff, actions, highlight }: { diff: DiffResult | null; actions?: DiffActions; highlight?: string }): ReactNode {
  if (!diff) return <div className="diff-loading">{t('Загружаю изменения…')}</div>
  if (!diff.files.length) return <div className="diff-note">{t('Изменений нет')}</div>
  return (
    <div className="diff">
      {diff.truncated && <div className="banner warn">{t('Изменения слишком большие и показаны не полностью.')}</div>}
      {diff.files.map((file, index) => (
        <FileBlock key={`${file.path}-${index}`} file={file} defaultOpen={diff.files.length <= 20} actions={actions} highlight={highlight} />
      ))}
    </div>
  )
}
