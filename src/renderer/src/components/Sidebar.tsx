import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import type { RefInfo } from '../../../shared/types'
import { useRepo, type View } from '../store'
import { CleanHistoryDialog, ConfirmDialog, PromptDialog, PushDialog, RenameBranchDialog, RenameRemoteBranchDialog, ReplaceAuthorDialog, useDialogs } from './dialogs'
import { ContextMenu, Icon, type MenuItem } from './ui'

function TrackBadge({ info }: { info: RefInfo }): ReactNode {
  if (!info.ahead && !info.behind) return null
  return (
    <span className="track">
      {info.ahead ? <span>↑{info.ahead}</span> : null}
      {info.behind ? <span>↓{info.behind}</span> : null}
    </span>
  )
}

function Section({ title, count, children, action }: { title: string; count: number; children: ReactNode; action?: ReactNode }): ReactNode {
  const [open, setOpen] = useState(true)
  return (
    <section className="side-section">
      <div className="side-section-head">
        <button onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name="chevron" size={11} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
          {title}<span className="count">{count}</span>
        </button>
        {action}
      </div>
      {open && children}
    </section>
  )
}

export function Sidebar(): ReactNode {
  const { snapshot, view, setView, client, run, setSelected } = useRepo()
  const { show } = useDialogs()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const refs = useMemo(() => snapshot?.refs ?? [], [snapshot?.refs])
  const branches = refs.filter((ref) => ref.kind === 'branch')
  const tags = refs.filter((ref) => ref.kind === 'tag')
  const remotes = snapshot?.remotes ?? []
  const status = snapshot?.status
  const changes = status?.files.length ?? 0
  const pending = snapshot?.schedules.filter((item) => item.state === 'pending').length ?? 0
  const defaults = new Set(remotes.map((remote) => `${remote.name}/${remote.defaultBranch}`))

  const nav: { id: View; label: string; icon: string; count?: number }[] = [
    { id: 'history', label: 'История', icon: 'history' },
    { id: 'changes', label: 'Изменения', icon: 'changes', count: changes },
    { id: 'stash', label: 'Stash', icon: 'stash', count: snapshot?.stashes.length },
    { id: 'requests', label: snapshot?.forge?.kind === 'gitlab' ? 'Merge Requests' : 'Pull Requests', icon: 'merge' },
    { id: 'schedule', label: 'Публикации', icon: 'schedule', count: pending },
    { id: 'journal', label: 'Журнал', icon: 'journal' }
  ]

  const jumpTo = (sha: string): void => {
    setView('history')
    setSelected([sha])
  }

  const branchMenu = (event: MouseEvent, branch: RefInfo): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: 'Перейти на ветку', icon: 'branch', disabled: branch.isHead, run: () => void run('Переключаюсь', () => client.checkout(branch.name)) },
        { label: 'Переименовать…', run: () => show(<RenameBranchDialog name={branch.name} upstream={branch.upstream} isDefault={defaults.has(branch.upstream ?? '')} />) },
        { label: 'Отправить на сервер…', icon: 'push', run: () => show(<PushDialog branch={branch.name} />) },
        { label: `Влить в ${status?.head ?? 'текущую'}`, disabled: branch.isHead || !status?.head, run: () => void run('Вливаю', () => client.mergeBranch(branch.ref)) },
        { separator: true },
        {
          label: 'Удалить…', icon: 'trash', danger: true, disabled: branch.isHead,
          run: () => show(<ConfirmDialog
            title="Удалить ветку"
            danger
            confirmLabel="Удалить"
            body={<>Локальная ветка <b>{branch.name}</b> будет удалена. Сервер не изменится. Если в ней есть невлитые коммиты, найти их можно будет через reflog.</>}
            onConfirm={() => void run('Удаляю ветку', () => client.deleteBranch(branch.name, true))}
          />)
        }
      ]
    })
  }

  const remoteBranchMenu = (event: MouseEvent, remote: string, ref: RefInfo): void => {
    event.preventDefault()
    const name = ref.name.slice(remote.length + 1)
    const isDefault = defaults.has(ref.name)
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: 'Создать локальную ветку', icon: 'branch', run: () => void run('Переключаюсь', () => client.checkoutRemoteBranch(ref.name)) },
        { label: 'Переименовать на сервере…', run: () => show(<RenameRemoteBranchDialog remote={remote} name={name} />) },
        {
          label: 'Сделать основной на сервере…',
          disabled: isDefault || !snapshot?.forge?.account || snapshot.forge.remote !== remote,
          run: () => show(<ConfirmDialog
            title="Сменить основную ветку"
            confirmLabel="Сделать основной"
            body={<>Ветка <b>{name}</b> станет основной на <b>{remote}</b>. Новые клоны и запросы будут использовать её по умолчанию.</>}
            onConfirm={() => void run('Меняю основную ветку', () => client.forgeSetDefaultBranch(name, remote))}
          />)
        },
        { separator: true },
        {
          label: 'Удалить с сервера…', icon: 'trash', danger: true, disabled: isDefault,
          run: () => show(<ConfirmDialog
            title="Удалить ветку с сервера"
            danger
            confirmLabel="Удалить с сервера"
            body={<>Ветка <b>{name}</b> будет удалена на <b>{remote}</b>. Открытые Pull Request и Merge Request от неё могут закрыться.</>}
            onConfirm={() => void run('Удаляю с сервера', () => client.deleteRemoteBranch(remote, name))}
          />)
        }
      ]
    })
  }

  const tagMenu = (event: MouseEvent, tag: RefInfo): void => {
    event.preventDefault()
    const remote = remotes[0]?.name
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        {
          label: 'Удалить локально…', icon: 'trash', danger: true,
          run: () => show(<ConfirmDialog title="Удалить тег" danger confirmLabel="Удалить" body={<>Тег <b>{tag.name}</b> будет удалён локально.</>} onConfirm={() => void run('Удаляю тег', () => client.deleteTag(tag.name))} />)
        },
        ...(remote ? [{
          label: `Удалить также с ${remote}…`, icon: 'trash', danger: true,
          run: () => show(<ConfirmDialog title="Удалить тег с сервера" danger confirmLabel="Удалить везде" body={<>Тег <b>{tag.name}</b> будет удалён локально и на <b>{remote}</b>.</>} onConfirm={() => void run('Удаляю тег', () => client.deleteTag(tag.name, remote))} />)
        }] : [])
      ]
    })
  }

  return (
    <aside className="sidebar">
      <nav className="side-nav" aria-label="Разделы">
        {nav.map((item) => (
          <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>
            <Icon name={item.icon} />{item.label}
            {item.count ? <span className="count">{item.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="side-scroll">
        <Section
          title="Ветки"
          count={branches.length}
          action={<button className="icon-btn" title="Новая ветка" aria-label="Новая ветка" onClick={() => show(<PromptDialog
            title="Новая ветка"
            label="Имя ветки"
            confirmLabel="Создать и перейти"
            onSubmit={(name) => void run('Создаю ветку', () => client.createBranch(name, 'HEAD', true))}
          />)}><Icon name="plus" size={13} /></button>}
        >
          {branches.map((branch) => (
            <button
              key={branch.ref}
              className={`side-item ${branch.isHead ? 'active' : ''}`}
              title={branch.name}
              onClick={() => jumpTo(branch.target)}
              onDoubleClick={() => { if (!branch.isHead) void run('Переключаюсь', () => client.checkout(branch.name)) }}
              onContextMenu={(event) => branchMenu(event, branch)}
            >
              {branch.isHead ? <span className="head-dot" /> : <Icon name="branch" size={13} />}
              <span className="truncate">{branch.name}</span>
              <TrackBadge info={branch} />
            </button>
          ))}
        </Section>
        {remotes.map((remote) => {
          const list = refs.filter((ref) => ref.kind === 'remote' && ref.name.startsWith(`${remote.name}/`))
          return (
            <Section key={remote.name} title={remote.name} count={list.length}>
              {list.map((ref) => (
                <button key={ref.ref} className="side-item" title={ref.name} onClick={() => jumpTo(ref.target)} onContextMenu={(event) => remoteBranchMenu(event, remote.name, ref)}>
                  <Icon name="cloud" size={13} />
                  <span className="truncate">{ref.name.slice(remote.name.length + 1)}</span>
                  {defaults.has(ref.name) && <span className="pill small">основная</span>}
                </button>
              ))}
            </Section>
          )
        })}
        <Section title="Теги" count={tags.length}>
          {tags.map((tag) => (
            <button key={tag.ref} className="side-item" title={tag.name} onClick={() => jumpTo(tag.target)} onContextMenu={(event) => tagMenu(event, tag)}>
              <Icon name="tag" size={13} />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
        </Section>
      </div>
      <div className="side-tools">
        <button onClick={() => { setView('history'); show(<ReplaceAuthorDialog />) }}><Icon name="users" size={14} />Заменить автора</button>
        <button onClick={() => show(<CleanHistoryDialog />)}><Icon name="broom" size={14} />Очистка истории</button>
        {!remotes.length && (
          <button onClick={() => show(<PromptDialog
            title="Добавить remote"
            label="URL репозитория"
            placeholder="git@gitlab.com:team/project.git"
            confirmLabel="Добавить как origin"
            onSubmit={(url) => void run('Добавляю remote', async () => {
              await client.addRemote('origin', url)
              await client.fetchAll()
            })}
          />)}><Icon name="cloud" size={14} />Добавить remote</button>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
