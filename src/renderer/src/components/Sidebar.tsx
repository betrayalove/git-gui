import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { defaultBranchSettingsUrl, newRequestUrl, requestLabel, requestsPageUrl } from '../../../shared/remote-url'
import type { RefInfo } from '../../../shared/types'
import { appApi } from '../api'
import { useRepo, type View } from '../store'
import { CleanHistoryDialog, ConfirmDialog, PromptDialog, PushDialog, RenameBranchDialog, RenameRemoteBranchDialog, ReplaceAuthorDialog, useDialogs } from './dialogs'
import { MergeDialog } from './MergeDialogs'
import { RebaseDialog } from './RebaseDialog'
import { AddWorktreeDialog, RepoExtrasSections } from './RepoExtras'
import { ContextMenu, Icon, type MenuItem } from './ui'
import { t } from '../../../shared/i18n'

function TrackBadge({ info }: { info: RefInfo }): ReactNode {
  if (!info.ahead && !info.behind) return null
  return (
    <span className="track">
      {info.ahead ? <span>↑{info.ahead}</span> : null}
      {info.behind ? <span>↓{info.behind}</span> : null}
    </span>
  )
}

export function Section({ title, count, children, action }: { title: string; count: number; children: ReactNode; action?: ReactNode }): ReactNode {
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
  const { snapshot, view, setView, client, run, jumpTo, reload } = useRepo()
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
  const forge = snapshot?.forge
  const requestsPage = forge ? requestsPageUrl(forge) : null
  const label = requestLabel(forge?.kind ?? null)

  const nav: { id: View; label: string; icon: string; count?: number }[] = [
    { id: 'history', label: t('История'), icon: 'history' },
    { id: 'changes', label: t('Изменения'), icon: 'changes', count: changes },
    { id: 'files', label: t('Файлы'), icon: 'file' },
    { id: 'stash', label: 'Stash', icon: 'stash', count: snapshot?.stashes.length },
    { id: 'schedule', label: t('Публикации'), icon: 'schedule', count: pending },
    { id: 'dependencies', label: t('Зависимости'), icon: 'shield' },
    { id: 'journal', label: t('Журнал'), icon: 'journal' }
  ]

  const branchMenu = (event: MouseEvent, branch: RefInfo): void => {
    event.preventDefault()
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: t('Перейти на ветку'), icon: 'branch', disabled: branch.isHead, run: () => void run(t('Переключаюсь'), () => client.checkout(branch.name)) },
        { label: t('Переименовать…'), run: () => show(<RenameBranchDialog name={branch.name} upstream={branch.upstream} isDefault={defaults.has(branch.upstream ?? '')} />) },
        { label: t('Отправить на сервер…'), icon: 'push', run: () => show(<PushDialog branch={branch.name} />) },
        { label: t('Перенести на другую ветку…'), icon: 'branch', run: () => show(<RebaseDialog branch={branch.name} />) },
        ...(forge && branch.upstream?.startsWith(`${forge.remote}/`) && newRequestUrl(forge, branch.upstream.slice(forge.remote.length + 1)) ? [{
          label: t('Создать {label} на сайте', { label }),
          icon: 'external',
          run: () => void appApi.openExternal(newRequestUrl(forge, branch.upstream!.slice(forge.remote.length + 1))!)
        }] : []),
        { label: t('Влить в {value}', { value: status?.head ?? t('текущую') }), disabled: branch.isHead || !status?.head, run: () => show(<MergeDialog target={branch.name} />) },
        { separator: true },
        {
          label: t('Удалить…'), icon: 'trash', danger: true, disabled: branch.isHead,
          run: () => show(<ConfirmDialog
            title={t('Удалить ветку')}
            danger
            confirmLabel={t('Удалить')}
            body={<>{t('Локальная ветка')} <b>{branch.name}</b> {t('будет удалена. Сервер не изменится. Если в ней есть невлитые коммиты, найти их можно будет через reflog.')}</>}
            onConfirm={() => void run(t('Удаляю ветку'), () => client.deleteBranch(branch.name, true))}
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
        { label: t('Создать локальную ветку'), icon: 'branch', run: () => void run(t('Переключаюсь'), () => client.checkoutRemoteBranch(ref.name)) },
        { label: t('Переименовать на сервере…'), run: () => show(<RenameRemoteBranchDialog remote={remote} name={name} />) },
        ...(forge?.remote === remote && defaultBranchSettingsUrl(forge) ? [{
          label: t('Сменить основную ветку на сайте'),
          icon: 'external',
          run: () => void appApi.openExternal(defaultBranchSettingsUrl(forge)!)
        }] : []),
        { separator: true },
        {
          label: t('Удалить с сервера…'), icon: 'trash', danger: true, disabled: isDefault,
          run: () => show(<ConfirmDialog
            title={t('Удалить ветку с сервера')}
            danger
            confirmLabel={t('Удалить с сервера')}
            body={<>{t('Ветка')} <b>{name}</b> {t('будет удалена на')} <b>{remote}</b>{t('. Открытые Pull Request и Merge Request от неё могут закрыться.')}</>}
            onConfirm={() => void run(t('Удаляю с сервера'), () => client.deleteRemoteBranch(remote, name))}
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
          label: t('Удалить локально…'), icon: 'trash', danger: true,
          run: () => show(<ConfirmDialog title={t('Удалить тег')} danger confirmLabel={t('Удалить')} body={<>{t('Тег')} <b>{tag.name}</b> {t('будет удалён локально.')}</>} onConfirm={() => void run(t('Удаляю тег'), () => client.deleteTag(tag.name))} />)
        },
        ...(remote ? [{
          label: t('Удалить также с {remote}…', { remote }), icon: 'trash', danger: true,
          run: () => show(<ConfirmDialog title={t('Удалить тег с сервера')} danger confirmLabel={t('Удалить везде')} body={<>{t('Тег')} <b>{tag.name}</b> {t('будет удалён локально и на')} <b>{remote}</b>.</>} onConfirm={() => void run(t('Удаляю тег'), () => client.deleteTag(tag.name, remote))} />)
        }] : [])
      ]
    })
  }

  return (
    <aside className="sidebar">
      <nav className="side-nav" aria-label={t('Разделы')}>
        {nav.map((item) => (
          <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>
            <Icon name={item.icon} />{item.label}
            {item.count ? <span className="count">{item.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="side-scroll">
        <Section
          title={t('Ветки')}
          count={branches.length}
          action={<button className="icon-btn" title={t('Новая ветка')} aria-label={t('Новая ветка')} onClick={() => show(<PromptDialog
            title={t('Новая ветка')}
            label={t('Имя ветки')}
            confirmLabel={t('Создать и перейти')}
            onSubmit={(name) => void run(t('Создаю ветку'), () => client.createBranch(name, 'HEAD', true))}
          />)}><Icon name="plus" size={13} /></button>}
        >
          {branches.map((branch) => (
            <button
              key={branch.ref}
              className={`side-item ${branch.isHead ? 'active' : ''}`}
              title={branch.name}
              onClick={() => jumpTo(branch.target)}
              onDoubleClick={() => { if (!branch.isHead) void run(t('Переключаюсь'), () => client.checkout(branch.name)) }}
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
                  {defaults.has(ref.name) && <span className="pill small">{t('основная')}</span>}
                </button>
              ))}
            </Section>
          )
        })}
        <RepoExtrasSections Section={Section} />
        <Section title={t('Теги')} count={tags.length}>
          {tags.map((tag) => (
            <button key={tag.ref} className="side-item" title={tag.name} onClick={() => jumpTo(tag.target)} onContextMenu={(event) => tagMenu(event, tag)}>
              <Icon name="tag" size={13} />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
        </Section>
      </div>
      <div className="side-tools">
        <button onClick={() => { setView('history'); show(<ReplaceAuthorDialog />) }}><Icon name="users" size={14} />{t('Заменить автора')}</button>
        <button onClick={() => show(<CleanHistoryDialog />)}><Icon name="broom" size={14} />{t('Очистка истории')}</button>
        <button onClick={() => show(<AddWorktreeDialog onDone={() => void reload()} />)}><Icon name="folder" size={14} />{t('Ветка в отдельной папке')}</button>
        {requestsPage && (
          <button onClick={() => void appApi.openExternal(requestsPage)}><Icon name="external" size={14} />{label} {t('на сайте')}</button>
        )}
        {!remotes.length && (
          <button onClick={() => show(<PromptDialog
            title={t('Добавить remote')}
            label={t('URL репозитория')}
            placeholder="git@gitlab.com:team/project.git"
            confirmLabel={t('Добавить как origin')}
            onSubmit={(url) => void run(t('Добавляю remote'), async () => {
              await client.addRemote('origin', url)
              await client.fetchAll()
            })}
          />)}><Icon name="cloud" size={14} />{t('Добавить remote')}</button>
        )}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
