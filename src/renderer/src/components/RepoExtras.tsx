import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { LfsInfo, Submodule, Worktree } from '../../../shared/types'
import { appApi } from '../api'
import { shortSha } from '../format'
import { useRepo } from '../store'
import { ConfirmDialog, PromptDialog, useDialogs } from './dialogs'
import { ContextMenu, Icon, Modal, type MenuItem } from './ui'

function baseName(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path
}

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
    void run('Создаю рабочую копию', async () => {
      await client.addWorktree({ path: folder, branch, newBranch: mode === 'new', from: 'HEAD' })
      onDone()
      toast('success', `Ветка ${branch} открыта в отдельной папке`, { label: 'Открыть', run: () => openRepository(folder) })
    })
  }
  return (
    <Modal
      title="Новая рабочая копия"
      onClose={close}
      footer={<>
        <button className="btn btn-ghost" onClick={close}>Отмена</button>
        <button className="btn btn-primary" disabled={!folder} onClick={submit}>Создать</button>
      </>}
    >
      <p className="prose">Рабочая копия (worktree) открывает другую ветку в отдельной папке. Можно работать над двумя ветками сразу, не переключаясь и не прячая изменения в stash.</p>
      <div className="segmented">
        <button className={mode === 'existing' ? 'active' : ''} disabled={!branches.length} onClick={() => setMode('existing')}>Существующая ветка</button>
        <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>Новая ветка</button>
      </div>
      {mode === 'existing'
        ? (
          <label className="field">
            <span>Ветка</span>
            <select value={existing} onChange={(event) => setExisting(event.target.value)}>
              {branches.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )
        : (
          <label className="field">
            <span>Имя новой ветки, от {snapshot?.status.head ?? 'текущего коммита'}</span>
            <input autoFocus value={created} onChange={(event) => setCreated(event.target.value)} />
          </label>
        )}
      <div className="field">
        <span>Где создать папку</span>
        <button className="btn" onClick={() => void appApi.pickFolder().then(setParent)}><Icon name="folder" size={14} />{parent ?? 'Выбрать папку'}</button>
      </div>
      {folder && <p className="hint">Будет создана папка {folder}</p>}
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

const SUBMODULE_PILL: Partial<Record<Submodule['state'], string>> = { missing: 'не загружен', changed: 'другой коммит', conflict: 'конфликт' }

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
    const remove = (force: boolean): void => void run('Удаляю рабочую копию', async () => {
      await client.removeWorktree(worktree.path, force)
      refresh()
    })
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: 'Открыть', icon: 'folder', disabled: worktree.current || worktree.prunable, run: () => openRepository(worktree.path) },
        { label: 'Показать папку', disabled: worktree.prunable, run: () => void appApi.revealPath(worktree.path) },
        { separator: true },
        worktree.prunable
          ? { label: 'Забыть: папки больше нет', run: () => void run('Убираю', async () => { await client.pruneWorktrees(); refresh() }) }
          : {
            label: 'Удалить…', icon: 'trash', danger: true, disabled: worktree.main || worktree.current,
            run: () => show(<ConfirmDialog
              title="Удалить рабочую копию"
              danger
              confirmLabel="Удалить папку"
              body={<>Папка <code>{worktree.path}</code> будет удалена. Ветка {worktree.branch ? <b>{worktree.branch}</b> : 'и её коммиты'} останется в репозитории. Если в папке есть незакоммиченные изменения, git откажется, и их можно будет удалить отдельно.</>}
              onConfirm={() => remove(false)}
            />)
          },
        ...(!worktree.prunable && !worktree.main && !worktree.current ? [{
          label: 'Удалить вместе с незакоммиченными изменениями…', danger: true,
          run: () => show(<ConfirmDialog title="Удалить с изменениями" danger confirmLabel="Удалить всё" body={<>Папка <code>{worktree.path}</code> будет удалена вместе с незакоммиченными изменениями. Это нельзя отменить.</>} onConfirm={() => remove(true)} />)
        }] : [])
      ]
    })
  }

  const submoduleMenu = (event: MouseEvent, submodule: Submodule): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: 'Открыть как репозиторий', icon: 'folder', disabled: submodule.state === 'missing', run: () => void client.listWorktrees().then((list) => openRepository(`${list.find((item) => item.current)!.path}/${submodule.path}`)) },
        { label: submodule.state === 'missing' ? 'Загрузить' : 'Вернуть записанный коммит', icon: 'fetch', run: () => void run('Обновляю submodule', async () => { await client.updateSubmodules([submodule.path]); refresh() }) }
      ]
    })
  }

  return (
    <>
      {worktrees.length > 1 && (
        <Section title="Рабочие копии" count={worktrees.length} action={<button className="icon-btn" title="Новая рабочая копия" aria-label="Новая рабочая копия" onClick={() => show(<AddWorktreeDialog onDone={refresh} />)}><Icon name="plus" size={13} /></button>}>
          {worktrees.map((worktree) => (
            <Row
              key={worktree.path}
              icon="folder"
              title={worktree.branch ?? `HEAD ${worktree.head ? shortSha(worktree.head) : ''}`}
              detail={worktree.path}
              active={worktree.current}
              pill={worktree.prunable ? <span className="pill small warn">нет папки</span> : worktree.main ? <span className="pill small">основная</span> : null}
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
          action={missing > 0 ? <button className="icon-btn" title="Загрузить все" aria-label="Загрузить все submodules" onClick={() => void run('Загружаю submodules', async () => { await client.updateSubmodules(); refresh() })}><Icon name="fetch" size={13} /></button> : undefined}
        >
          {submodules.map((submodule) => (
            <Row
              key={submodule.path}
              icon="stash"
              title={submodule.path}
              detail={`${submodule.url ?? ''}\n${shortSha(submodule.sha)}`}
              pill={SUBMODULE_PILL[submodule.state] ? <span className="pill small warn">{SUBMODULE_PILL[submodule.state]}</span> : null}
              onMenu={(event) => submoduleMenu(event, submodule)}
              onClick={(): void => { if (submodule.state === 'missing') void run('Загружаю submodule', async () => { await client.updateSubmodules([submodule.path]); refresh() }) }}
            />
          ))}
        </Section>
      )}
      {lfs && (lfs.used || lfs.patterns.length > 0) && (
        <Section
          title="LFS"
          count={lfs.files.length}
          action={<button className="icon-btn" title="Хранить в LFS по маске" aria-label="Хранить в LFS по маске" disabled={!lfs.installed} onClick={() => show(<PromptDialog
            title="Хранить в LFS"
            label="Маска файлов"
            placeholder="*.psd"
            confirmLabel="Добавить"
            hint="Новые файлы по этой маске будут храниться в LFS. Уже сохранённая история не изменится."
            onSubmit={(pattern) => void run('Добавляю маску', async () => { await client.lfsTrack(pattern); refresh(); toast('success', `Маска ${pattern} добавлена в .gitattributes`) })}
          />)}><Icon name="plus" size={13} /></button>}
        >
          {!lfs.installed && (
            <div className="side-note">
              <Icon name="warning" size={13} />
              <span>Репозиторий хранит файлы в Git LFS, но он не установлен. Вместо файлов будут ссылки на них. <button className="link" onClick={() => void appApi.openExternal('https://git-lfs.com')}>Установить</button></span>
            </div>
          )}
          {lfs.installed && notDownloaded > 0 && (
            <Row icon="fetch" title={`Скачать файлы: ${notDownloaded}`} onClick={() => void run('Скачиваю LFS-файлы', async () => { await client.lfsPull(); refresh() })} />
          )}
          {lfs.patterns.map((pattern) => <Row key={pattern} icon="file" title={pattern} detail="Хранится в LFS" />)}
        </Section>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  )
}
