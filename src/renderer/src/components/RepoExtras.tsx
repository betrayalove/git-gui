import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { LfsInfo, Submodule, Worktree } from '../../../shared/types'
import { appApi } from '../api'
import { baseName, shortSha } from '../format'
import { useRepo } from '../store'
import { ConfirmDialog, PromptDialog, useDialogs } from './dialogs'
import { ContextMenu, Icon, Modal, type MenuItem } from './ui'
import { t } from '../../../shared/i18n'


function joinPath(parent: string, name: string): string {
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`
}

/** Worktrees, submodules and LFS of the open repository, reread when its branches move. */
export function useRepoExtras(): { worktrees: Worktree[]; submodules: Submodule[]; lfs: LfsInfo | null; refresh: () => void } {
  const { client, snapshot } = useRepo()
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [submodules, setSubmodules] = useState<Submodule[]>([])
  const [lfs, setLfs] = useState<LfsInfo | null>(null)
  const [round, setRound] = useState(0)
  const refresh = useCallback(() => setRound((value) => value + 1), [])
  const key = `${snapshot?.status.headSha}|${snapshot?.refs.length}|${snapshot?.status.files.length}`
  useEffect(() => {
    let cancelled = false
    void client.listWorktrees().then((list) => { if (!cancelled) setWorktrees(list) }).catch(() => {})
    void client.listSubmodules().then((list) => { if (!cancelled) setSubmodules(list) }).catch(() => {})
    void client.lfsInfo().then((info) => { if (!cancelled) setLfs(info) }).catch(() => {})
    return () => { cancelled = true }
  }, [client, key, round])
  return { worktrees, submodules, lfs, refresh }
}

export function AddWorktreeDialog({ onDone }: { onDone: () => void }): ReactNode {
  const { repo, snapshot, client, run, toast, openRepository } = useRepo()
  const { close } = useDialogs()
  const branches = (snapshot?.refs ?? []).filter((ref) => ref.kind === 'branch' && !ref.isHead).map((ref) => ref.name)
  const [mode, setMode] = useState<'existing' | 'new'>(branches.length ? 'existing' : 'new')
  const [existing, setExisting] = useState(branches[0] ?? '')
  const [created, setCreated] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const branch = mode === 'existing' ? existing : created.trim()
  const folder = parent && branch ? joinPath(parent, `${baseName(repo)}-${branch.replace(/[^\w.-]+/g, '-')}`) : null
  const submit = (): void => {
    if (!folder) return
    close()
    void run(t('Создаю рабочую копию'), async () => {
      await client.addWorktree({ path: folder, branch, newBranch: mode === 'new', from: 'HEAD' })
      onDone()
      toast('success', t('Ветка {branch} открыта в отдельной папке', { branch }), { label: t('Открыть'), run: () => openRepository(folder) })
    })
  }
  return (
    <Modal
      title={t('Новая рабочая копия')}
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>{t('Отмена')}</button>
        <button className="btn btn-primary" disabled={!folder} onClick={submit}>{t('Создать')}</button>
      </>}
    >
      <p className="prose">{t('Рабочая копия (worktree) открывает другую ветку в отдельной папке. Можно работать над двумя ветками сразу, не переключаясь и не прячая изменения в stash.')}</p>
      <div className="segmented">
        <button className={mode === 'existing' ? 'active' : ''} disabled={!branches.length} onClick={() => setMode('existing')}>{t('Существующая ветка')}</button>
        <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>{t('Новая ветка')}</button>
      </div>
      {mode === 'existing'
        ? (
          <label className="field">
            <span>{t('Ветка')}</span>
            <select value={existing} onChange={(event) => setExisting(event.target.value)}>
              {branches.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )
        : (
          <label className="field">
            <span>{t('Имя новой ветки, от')} {snapshot?.status.head ?? t('текущего коммита')}</span>
            <input autoFocus value={created} onChange={(event) => setCreated(event.target.value)} />
          </label>
        )}
      <div className="field">
        <span>{t('Где создать папку')}</span>
        <button className="btn" onClick={() => void appApi.pickFolder().then(setParent)}><Icon name="folder" size={14} />{parent ?? t('Выбрать папку')}</button>
      </div>
      {folder && <p className="hint">{t('Будет создана папка')} {folder}</p>}
    </Modal>
  )
}

function Row({ icon, title, detail, pill, active, onClick, onMenu }: {
  icon: string
  title: string
  detail?: string
  pill?: ReactNode
  active?: boolean
  onClick?: () => void
  onMenu?: (event: MouseEvent) => void
}): ReactNode {
  return (
    <button className={`side-item ${active ? 'active' : ''}`} title={detail ? `${title}\n${detail}` : title} onClick={onClick} onContextMenu={onMenu}>
      <Icon name={icon} size={13} />
      <span className="truncate">{title}</span>
      {pill}
    </button>
  )
}

const SUBMODULE_PILL: Partial<Record<Submodule['state'], string>> = { missing: t('не загружен'), changed: t('другой коммит'), conflict: t('конфликт') }

/** Sidebar sections for checkouts, submodules and LFS. Each appears only when it has something to show. */
export function RepoExtrasSections({ Section }: { Section: (props: { title: string; count: number; children: ReactNode; action?: ReactNode }) => ReactNode }): ReactNode {
  const { client, run, toast, openRepository } = useRepo()
  const { show } = useDialogs()
  const { worktrees, submodules, lfs, refresh } = useRepoExtras()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const missing = submodules.filter((item) => item.state === 'missing').length
  const notDownloaded = lfs?.files.filter((file) => !file.downloaded).length ?? 0

  const worktreeMenu = (event: MouseEvent, worktree: Worktree): void => {
    event.preventDefault()
    const remove = (force: boolean): void => void run(t('Удаляю рабочую копию'), async () => {
      await client.removeWorktree(worktree.path, force)
      refresh()
    })
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: t('Открыть'), icon: 'folder', disabled: worktree.current || worktree.prunable, run: () => openRepository(worktree.path) },
        { label: t('Показать папку'), disabled: worktree.prunable, run: () => void appApi.revealPath(worktree.path) },
        { separator: true },
        worktree.prunable
          ? { label: t('Забыть: папки больше нет'), run: () => void run(t('Убираю'), async () => { await client.pruneWorktrees(); refresh() }) }
          : {
            label: t('Удалить…'), icon: 'trash', danger: true, disabled: worktree.main || worktree.current,
            run: () => show(<ConfirmDialog
              title={t('Удалить рабочую копию')}
              danger
              confirmLabel={t('Удалить папку')}
              body={<>{t('Папка')} <code>{worktree.path}</code> {t('будет удалена. Ветка')} {worktree.branch ? <b>{worktree.branch}</b> : t('и её коммиты')} {t('останется в репозитории. Если в папке есть незакоммиченные изменения, git откажется, и их можно будет удалить отдельно.')}</>}
              onConfirm={() => remove(false)}
            />)
          },
        ...(!worktree.prunable && !worktree.main && !worktree.current ? [{
          label: t('Удалить вместе с незакоммиченными изменениями…'), danger: true,
          run: () => show(<ConfirmDialog title={t('Удалить с изменениями')} danger confirmLabel={t('Удалить всё')} body={<>{t('Папка')} <code>{worktree.path}</code> {t('будет удалена вместе с незакоммиченными изменениями. Это нельзя отменить.')}</>} onConfirm={() => remove(true)} />)
        }] : [])
      ]
    })
  }

  const submoduleMenu = (event: MouseEvent, submodule: Submodule): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: t('Открыть как репозиторий'), icon: 'folder', disabled: submodule.state === 'missing', run: () => void client.listWorktrees().then((list) => openRepository(`${list.find((item) => item.current)!.path}/${submodule.path}`)) },
        { label: submodule.state === 'missing' ? t('Загрузить') : t('Вернуть записанный коммит'), icon: 'fetch', run: () => void run(t('Обновляю submodule'), async () => { await client.updateSubmodules([submodule.path]); refresh() }) }
      ]
    })
  }

  return (
    <>
      {worktrees.length > 1 && (
        <Section title={t('Рабочие копии')} count={worktrees.length} action={<button className="icon-btn" title={t('Новая рабочая копия')} aria-label={t('Новая рабочая копия')} onClick={() => show(<AddWorktreeDialog onDone={refresh} />)}><Icon name="plus" size={13} /></button>}>
          {worktrees.map((worktree) => (
            <Row
              key={worktree.path}
              icon="folder"
              title={worktree.branch ?? `HEAD ${worktree.head ? shortSha(worktree.head) : ''}`}
              detail={worktree.path}
              active={worktree.current}
              pill={worktree.prunable ? <span className="pill small warn">{t('нет папки')}</span> : worktree.main ? <span className="pill small">{t('основная')}</span> : null}
              onClick={() => { if (!worktree.current && !worktree.prunable) openRepository(worktree.path) }}
              onMenu={(event) => worktreeMenu(event, worktree)}
            />
          ))}
        </Section>
      )}
      {submodules.length > 0 && (
        <Section
          title="Submodules"
          count={submodules.length}
          action={missing > 0 ? <button className="icon-btn" title={t('Загрузить все')} aria-label={t('Загрузить все submodules')} onClick={() => void run(t('Загружаю submodules'), async () => { await client.updateSubmodules(); refresh() })}><Icon name="fetch" size={13} /></button> : undefined}
        >
          {submodules.map((submodule) => (
            <Row
              key={submodule.path}
              icon="stash"
              title={submodule.path}
              detail={`${submodule.url ?? ''}\n${shortSha(submodule.sha)}`}
              pill={SUBMODULE_PILL[submodule.state] ? <span className="pill small warn">{SUBMODULE_PILL[submodule.state]}</span> : null}
              onMenu={(event) => submoduleMenu(event, submodule)}
              onClick={(): void => { if (submodule.state === 'missing') void run(t('Загружаю submodule'), async () => { await client.updateSubmodules([submodule.path]); refresh() }) }}
            />
          ))}
        </Section>
      )}
      {lfs && (lfs.used || lfs.patterns.length > 0) && (
        <Section
          title="LFS"
          count={lfs.files.length}
          action={<button className="icon-btn" title={t('Хранить в LFS по маске')} aria-label={t('Хранить в LFS по маске')} disabled={!lfs.installed} onClick={() => show(<PromptDialog
            title={t('Хранить в LFS')}
            label={t('Маска файлов')}
            placeholder="*.psd"
            confirmLabel={t('Добавить')}
            hint={t('Новые файлы по этой маске будут храниться в LFS. Уже сохранённая история не изменится.')}
            onSubmit={(pattern) => void run(t('Добавляю маску'), async () => { await client.lfsTrack(pattern); refresh(); toast('success', t('Маска {pattern} добавлена в .gitattributes', { pattern })) })}
          />)}><Icon name="plus" size={13} /></button>}
        >
          {!lfs.installed && (
            <div className="side-note">
              <Icon name="warning" size={13} />
              <span>{t('Репозиторий хранит файлы в Git LFS, но он не установлен. Вместо файлов будут ссылки на них.')} <button className="link" onClick={() => void appApi.openExternal('https://git-lfs.com')}>{t('Установить')}</button></span>
            </div>
          )}
          {lfs.installed && notDownloaded > 0 && (
            <Row icon="fetch" title={t('Скачать файлы: {notDownloaded}', { notDownloaded })} onClick={() => void run(t('Скачиваю LFS-файлы'), async () => { await client.lfsPull(); refresh() })} />
          )}
          {lfs.patterns.map((pattern) => <Row key={pattern} icon="file" title={pattern} detail={t('Хранится в LFS')} />)}
        </Section>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  )
}
