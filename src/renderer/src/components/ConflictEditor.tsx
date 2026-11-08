import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { hasConflictMarkers, parseConflictMarkers, type ConflictSegment } from '../../../shared/patch'
import type { BlobContent, ConflictFile, ConflictResolution } from '../../../shared/types'
import { useRepo } from '../store'
import { Icon } from './ui'
import { t } from '../../../shared/i18n'

type Choice = 'ours' | 'theirs' | 'both'

function compose(segments: ConflictSegment[], choices: Record<number, Choice>): string {
  return segments.map((segment, index) => {
    if (segment.kind === 'text') return segment.text
    const choice = choices[index]
    if (choice === 'ours') return segment.ours
    if (choice === 'theirs') return segment.theirs
    if (choice === 'both') return segment.ours + segment.theirs
    const base = segment.base === undefined ? '' : `||||||| ${'base'}\n${segment.base}`
    return `<<<<<<< ${segment.oursLabel}\n${segment.ours}${base}=======\n${segment.theirs}>>>>>>> ${segment.theirsLabel}\n`
  }).join('')
}

/** Tail of a long unchanged run, enough to recognize where a conflict sits. */
function context(text: string, keep: 'start' | 'end'): string {
  const lines = text.split('\n')
  if (lines.length <= 7) return text
  return keep === 'end' ? `…\n${lines.slice(-6).join('\n')}` : `${lines.slice(0, 6).join('\n')}\n…`
}

export function ConflictEditor({ file, mergedText, oursLabel, theirsLabel, onChange }: {
  file: ConflictFile
  /** Already loaded merged text. Otherwise it is read from file.merged. */
  mergedText?: BlobContent | null
  oursLabel: string
  theirsLabel: string
  initial: ConflictResolution | null
  onChange: (resolution: ConflictResolution | null) => void
}): ReactNode {
  const { client } = useRepo()
  const [merged, setMerged] = useState<BlobContent | null | undefined>(mergedText)
  const [choices, setChoices] = useState<Record<number, Choice>>({})
  const [whole, setWhole] = useState<'ours' | 'theirs' | 'deleted' | null>(null)
  const [manual, setManual] = useState<string | null>(null)

  useEffect(() => {
    if (mergedText !== undefined) return
    if (!file.merged) {
      setMerged(null)
      return
    }
    let cancelled = false
    client.readBlob(file.merged)
      .then((result) => { if (!cancelled) setMerged(result) })
      .catch(() => { if (!cancelled) setMerged(null) })
    return () => { cancelled = true }
  }, [client, file.merged, mergedText])

  const textual = Boolean(merged && !merged.binary && !merged.tooLarge)
  const segments = useMemo(() => (textual ? parseConflictMarkers(merged!.text) : []), [merged, textual])
  const conflictCount = segments.filter((segment) => segment.kind === 'conflict').length
  const composed = useMemo(() => compose(segments, choices), [segments, choices])

  useEffect(() => {
    if (whole === 'ours') onChange(file.ours ? { blob: file.ours } : { deleted: true })
    else if (whole === 'theirs') onChange(file.theirs ? { blob: file.theirs } : { deleted: true })
    else if (whole === 'deleted') onChange({ deleted: true })
    else if (manual !== null) onChange(hasConflictMarkers(manual) ? null : { content: manual })
    else if (textual && conflictCount > 0 && !hasConflictMarkers(composed)) onChange({ content: composed })
    else onChange(null)
    // onChange is a fresh closure on every parent render; the answer depends only on these values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whole, manual, composed, textual, conflictCount, file.ours, file.theirs])

  const pickWhole = (value: 'ours' | 'theirs' | 'deleted'): void => {
    setWhole(whole === value ? null : value)
    setManual(null)
  }
  const choose = (index: number, choice: Choice): void => {
    setWhole(null)
    setChoices((current) => {
      const next = { ...current }
      if (next[index] === choice) delete next[index]
      else next[index] = choice
      return next
    })
  }

  return (
    <div className="conflict-editor">
      <div className="conflict-file-actions">
        <span>{t('Файл целиком:')}</span>
        <button className={`btn btn-small ${whole === 'ours' ? 'chosen' : ''}`} onClick={() => pickWhole('ours')}>
          {oursLabel}{file.ours ? '' : t(' (файла нет)')}
        </button>
        <button className={`btn btn-small ${whole === 'theirs' ? 'chosen' : ''}`} onClick={() => pickWhole('theirs')}>
          {theirsLabel}{file.theirs ? '' : t(' (файла нет)')}
        </button>
        <button className={`btn btn-small ${whole === 'deleted' ? 'chosen' : ''}`} onClick={() => pickWhole('deleted')}>{t('Удалить файл')}</button>
        <span className="spacer" />
        {textual && (
          <button className="btn btn-small btn-ghost" onClick={() => { setWhole(null); setManual(manual === null ? composed : null) }}>
            {manual === null ? t('Редактировать вручную') : t('К выбору блоков')}
          </button>
        )}
      </div>
      {merged === undefined && <div className="diff-loading">{t('Загружаю файл…')}</div>}
      {merged?.binary && <div className="banner"><Icon name="warning" />{t('Бинарный файл: можно выбрать только версию целиком.')}</div>}
      {merged?.tooLarge && <div className="banner"><Icon name="warning" />{t('Файл слишком большой для редактора: выбери версию целиком.')}</div>}
      {merged === null && <div className="banner"><Icon name="warning" />{t('Версии файла с пометками нет: выбери версию целиком.')}</div>}
      {whole && <div className="banner">{t('Будет использован вариант:')} {whole === 'ours' ? oursLabel : whole === 'theirs' ? theirsLabel : t('файл удалён')}.</div>}
      {!whole && manual !== null && (
        <>
          {hasConflictMarkers(manual) && <div className="banner warn"><Icon name="warning" />{t('В тексте ещё есть пометки конфликта. Удали их, чтобы сохранить.')}</div>}
          <textarea className="conflict-manual" aria-label={t('Содержимое файла')} spellCheck={false} value={manual} onChange={(event) => setManual(event.target.value)} />
        </>
      )}
      {!whole && manual === null && textual && conflictCount === 0 && (
        <div className="banner">{t('В файле нет пометок конфликта. Выбери версию целиком или отредактируй вручную.')}</div>
      )}
      {!whole && manual === null && textual && segments.map((segment, index) => {
        if (segment.kind === 'text') {
          const shown = context(segment.text, index === 0 ? 'end' : index === segments.length - 1 ? 'start' : 'end')
          return <pre key={index} className="code-block conflict-context">{shown}</pre>
        }
        const choice = choices[index]
        return (
          <div key={index} className={`conflict-block ${choice ? 'done' : ''}`}>
            {choice ? (
              <div className="conflict-result">
                <div className="conflict-result-head">
                  <span>{t('Результат')}</span>
                  <button className="btn btn-small btn-ghost" onClick={() => choose(index, choice)}>{t('Изменить')}</button>
                </div>
                <pre className="code-block">{choice === 'ours' ? segment.ours : choice === 'theirs' ? segment.theirs : segment.ours + segment.theirs}</pre>
              </div>
            ) : (
              <>
                <div className="conflict-sides">
                  <div className="conflict-side">
                    <span>{oursLabel}</span>
                    <pre className="code-block">{segment.ours}</pre>
                    <button className="btn btn-small" onClick={() => choose(index, 'ours')}>{t('Оставить это')}</button>
                  </div>
                  <div className="conflict-side">
                    <span>{theirsLabel}</span>
                    <pre className="code-block">{segment.theirs}</pre>
                    <button className="btn btn-small" onClick={() => choose(index, 'theirs')}>{t('Оставить это')}</button>
                  </div>
                </div>
                <button className="btn btn-small btn-ghost conflict-both" onClick={() => choose(index, 'both')}>{t('Оставить оба')}</button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
