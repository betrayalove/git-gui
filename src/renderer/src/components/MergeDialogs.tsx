import { useEffect, useState, type ReactNode } from 'react'
import type { MergeMode, MergePreview, RebaseRange, RewritePlan, RewritePreview } from '../../../shared/types'
import { plural } from '../format'
import { useRepo } from '../store'
import { CommitLine, ReviewDialog, useDialogs } from './dialogs'
import { RebaseDialog } from './RebaseDialog'
import { ResultHistory } from './ResultHistory'
import { Icon, Modal } from './ui'
import { t } from '../../../shared/i18n'

function Incoming({ preview }: { preview: MergePreview }): ReactNode {
  return (
    <>
      <h4 className="add merge-incoming-head">{t('Придут коммиты:')} {preview.incomingCount}</h4>
      <ul className="commit-list">{preview.incoming.map((commit) => <CommitLine key={commit.sha} commit={commit} />)}</ul>
      {preview.incomingCount > preview.incoming.length && <p className="hint">{t('И ещё')} {preview.incomingCount - preview.incoming.length}.</p>}
    </>
  )
}

function PredictedConflicts({ files }: { files: string[] }): ReactNode {
  if (!files.length) return <div className="banner"><Icon name="check" />{t('Конфликтов не будет.')}</div>
  return (
    <div className="banner warn">
      <Icon name="warning" />
      <div>
        {t('Будут конфликты в')} {plural(files.length, 'файле', 'файлах', 'файлах')}{t('. Их можно будет разрешить на вкладке «Изменения»: для каждого файла выбрать, что должно получиться.')}
        <div className="mono-list">{files.slice(0, 8).join(', ')}{files.length > 8 ? t(' и ещё {value}', { value: files.length - 8 }) : ''}</div>
      </div>
    </div>
  )
}

/** Merges a branch into the current one, after showing what comes in and what will conflict. */
export function MergeDialog({ target }: { target: string }): ReactNode {
  const { client, run, toast, snapshot, setView } = useRepo()
  const { close, show } = useDialogs()
  const head = snapshot?.status.head
  const [preview, setPreview] = useState<MergePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<MergeMode>('auto')

  useEffect(() => {
    let cancelled = false
    client.mergePreview(target)
      .then((result) => { if (!cancelled) setPreview(result) })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [client, target])

  const merge = (): void => {
    close()
    void run(t('Вливаю'), async () => {
      await client.mergeBranch(target, mode)
      if (mode === 'squash') {
        setView('changes')
        toast('success', t('Изменения собраны в индексе. Осталось написать сообщение и сделать коммит.'))
      } else {
        toast('success', t('Ветка {target} влита в {head}', { target, head }))
      }
    })
  }
  return (
    <Modal
      title={t('Влить {target} в {value}', { target, value: head ?? t('текущую ветку') })}
      wide
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!preview || preview.upToDate} onClick={merge}>{t('Влить')}</button>
      </>}
    >
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {!preview && !error && <div className="diff-loading">{t('Проверяю, что получится…')}</div>}
      {preview?.upToDate && <div className="banner"><Icon name="check" />{t('Всё из')} {target} {t('уже есть в')} {head}.</div>}
      {preview && !preview.upToDate && (
        <>
          {!preview.fastForward && <PredictedConflicts files={preview.conflicts} />}
          <fieldset className="radio-group">
            <legend>{t('Как влить')}</legend>
            <label className="check">
              <input type="radio" checked={mode === 'auto'} onChange={() => setMode('auto')} />
              <span>{preview.fastForward ? t('Перемотать ветку вперёд, без merge-коммита') : t('Создать merge-коммит')}</span>
            </label>
            {preview.fastForward && (
              <label className="check">
                <input type="radio" checked={mode === 'no-ff'} onChange={() => setMode('no-ff')} />
                <span>{t('Всё равно создать merge-коммит, чтобы слияние было видно в истории')}</span>
              </label>
            )}
            <label className="check">
              <input type="radio" checked={mode === 'squash'} onChange={() => setMode('squash')} />
              <span>{t('Собрать все изменения в один новый коммит')}</span>
            </label>
          </fieldset>
          {!preview.fastForward && head && (
            <button className="link merge-alternative" onClick={() => show(<RebaseDialog branch={head} initialTarget={target} />)}>
              {t('Или перенести')} {plural(preview.localCount, 'свой коммит', 'свои коммита', 'своих коммитов')} {t('поверх')} {target}{t(', без merge-коммита')}
            </button>
          )}
          <Incoming preview={preview} />
        </>
      )}
    </Modal>
  )
}

interface RebaseOption {
  range: RebaseRange
  plan: RewritePlan | null
  preview: RewritePreview | null
}

/**
 * Brings the current branch up to date with its upstream. When both sides have new commits, the
 * person picks between rebase and merge, and sees conflicts for either before anything changes.
 */
export function PullDialog(): ReactNode {
  const { client, run, toast, snapshot } = useRepo()
  const { close, show } = useDialogs()
  const head = snapshot?.status.head
  const upstream = snapshot?.status.upstream
  const [merge, setMerge] = useState<MergePreview | null>(null)
  const [rebase, setRebase] = useState<RebaseOption | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<'rebase' | 'merge'>('rebase')

  useEffect(() => {
    if (!upstream || !head) return
    let cancelled = false
    void (async () => {
      try {
        await client.fetchAll()
        const result = await client.mergePreview(upstream)
        if (cancelled) return
        setMerge(result)
        if (result.upToDate || result.fastForward) return
        const range = await client.rebaseRange(head, upstream)
        const plan: RewritePlan | null = range.hasMerges ? null : {
          sequence: { base: range.base, tip: range.tip, onto: range.onto, todo: range.commits.map((commit) => ({ sha: commit.sha, action: 'pick' as const })) },
          description: t('Перенос {head} поверх {upstream}', { head, upstream })
        }
        const preview = plan ? await client.previewRewrite(plan) : null
        if (!cancelled) setRebase({ range, plan, preview })
      } catch (reason) {
        if (!cancelled) setError((reason as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [client, head, upstream])

  const fastForward = (): void => {
    close()
    void run(t('Подтягиваю'), async () => {
      await client.pull('ff-only')
      toast('success', t('Подтянуто коммитов: {incomingCount}', { incomingCount: merge!.incomingCount }))
    })
  }
  const proceed = (): void => {
    if (choice === 'rebase' && rebase?.plan) {
      show(<ReviewDialog plan={rebase.plan} />)
      return
    }
    close()
    void run(t('Подтягиваю'), async () => {
      await client.pull(choice === 'rebase' ? 'rebase' : 'merge')
      toast('success', t('Ветка обновлена'))
    })
  }
  const rebaseConflicts = rebase?.preview?.conflicts.length ?? 0
  const diverged = merge && !merge.upToDate && !merge.fastForward
  return (
    <Modal
      title={t('Подтянуть {value}', { value: upstream ?? '' })}
      wide
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        {merge?.fastForward && <button className="btn btn-primary" onClick={fastForward}>{t('Подтянуть')}</button>}
        {diverged && <button className="btn btn-primary" disabled={choice === 'rebase' && !rebase} onClick={proceed}>{choice === 'rebase' && rebaseConflicts ? t('Разрешить конфликты') : t('Дальше')}</button>}
      </>}
    >
      {!upstream && <div className="banner">{t('У ветки')} {head} {t('нет ветки на сервере. Отправь её кнопкой Push, и она появится.')}</div>}
      {error && <div className="banner danger"><Icon name="warning" />{error}</div>}
      {upstream && !merge && !error && <div className="diff-loading">{t('Получаю новое с сервера…')}</div>}
      {merge?.upToDate && (
        <div className="banner"><Icon name="check" />{t('Нового на сервере нет.')}{merge.localCount ? t(' У тебя {value}.', { value: plural(merge.localCount, 'неотправленный коммит', 'неотправленных коммита', 'неотправленных коммитов') }) : ''}</div>
      )}
      {merge?.fastForward && <Incoming preview={merge} />}
      {diverged && (
        <>
          <p className="prose">
            {t('И на сервере, и у тебя есть новые коммиты:')} {merge.incomingCount} {t('там и')} {merge.localCount} {t('здесь. Выбери, как их соединить.')}
          </p>
          <fieldset className="radio-group">
            <label className="check">
              <input type="radio" checked={choice === 'rebase'} onChange={() => setChoice('rebase')} />
              <span>
                {t('Перенести мои коммиты поверх, история останется прямой')}
                {rebase?.range.hasMerges && t(' (в ветке есть merge-коммиты, поэтому это сделает сам git)')}
              </span>
            </label>
            <label className="check">
              <input type="radio" checked={choice === 'merge'} onChange={() => setChoice('merge')} />
              <span>{t('Слить с merge-коммитом')}</span>
            </label>
          </fieldset>
          {choice === 'merge' && <PredictedConflicts files={merge.conflicts} />}
          {choice === 'rebase' && !rebase && <div className="diff-loading">{t('Строю результат…')}</div>}
          {choice === 'rebase' && rebase?.preview && (
            <>
              {rebaseConflicts > 0
                ? <div className="banner warn"><Icon name="warning" />{t('Конфликт в коммите «')}{rebase.preview.conflicts[0].subject}{t('». На следующем шаге можно выбрать, что должно получиться, ещё до каких-либо изменений.')}</div>
                : <div className="banner"><Icon name="check" />{t('Конфликтов не будет.')}</div>}
              {rebase.preview.warnings.map((text) => <div className="banner warn" key={text}><Icon name="warning" />{text}</div>)}
              {!rebaseConflicts && <ResultHistory preview={rebase.preview} />}
            </>
          )}
          <Incoming preview={merge} />
        </>
      )}
    </Modal>
  )
}
