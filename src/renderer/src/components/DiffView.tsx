import { useState, type ReactNode } from 'react'
import type { DiffResult, FileDiff } from '../../../shared/types'
import { Icon } from './ui'

const MAX_LINES_PER_FILE = 1500

export interface DiffActions {
  /** Controls shown on a hunk's header row. */
  hunk?: (file: FileDiff, hunkIndex: number) => ReactNode
  /** Controls shown on a file's header row. */
  file?: (file: FileDiff) => ReactNode
}

function FileBlock({ file, defaultOpen, actions }: { file: FileDiff; defaultOpen: boolean; actions?: DiffActions }): ReactNode {
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
          {file.binary && <div className="diff-note">Бинарный файл</div>}
          {!file.binary && !file.hunks.length && <div className="diff-note">Нет изменений в содержимом</div>}
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
                      <code>{line.text}</code>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {!showAll && total > MAX_LINES_PER_FILE && (
            <button className="btn btn-ghost diff-more" onClick={() => setShowAll(true)}>
              Показать все строки: {total}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

export function DiffView({ diff, actions }: { diff: DiffResult | null; actions?: DiffActions }): ReactNode {
  if (!diff) return <div className="diff-loading">Загружаю изменения…</div>
  if (!diff.files.length) return <div className="diff-note">Изменений нет</div>
  return (
    <div className="diff">
      {diff.truncated && <div className="banner warn">Изменения слишком большие и показаны не полностью.</div>}
      {diff.files.map((file, index) => (
        <FileBlock key={`${file.path}-${index}`} file={file} defaultOpen={diff.files.length <= 20} actions={actions} />
      ))}
    </div>
  )
}
