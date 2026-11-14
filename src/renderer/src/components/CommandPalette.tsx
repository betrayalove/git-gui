import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { filterCommands, type Command } from '../../../shared/commands'
import { requestLabel } from '../../../shared/remote-url'
import { useForgeAccounts } from '../forge-accounts'
import { baseName } from '../format'
import { CreateRequestDialog } from '../views/RequestsView'
import { shortcut } from '../keys'
import { useRepo } from '../store'
import { useTabs } from '../tabs'
import { SettingsDialog } from '../views/SettingsDialog'
import { SigningDialog } from './Signing'
import { NewBranchDialog, NewStashDialog, PushDialog, useDialogs } from './dialogs'
import { PullDialog } from './MergeDialogs'
import { VIEWS } from './Sidebar'
import { Icon } from './ui'
import { t } from '../../../shared/i18n'


/** Everything the palette can do in this repository right now. */
function useCommands(focusSearch: () => void): Command[] {
  const { snapshot, client, run, setView, fetchNow } = useRepo()
  const { show, close } = useDialogs()
  const { tabs, activeId, select, close: closeTab, add } = useTabs()
  const status = snapshot?.status
  const lastApplied = [...(snapshot?.journal ?? [])].reverse().find((entry) => entry.state === 'applied')
  const accounts = useForgeAccounts()
  const forge = snapshot?.forge
  const canRequest = Boolean(forge && accounts?.some((account) => account.host === forge.host))
  const views = t('Разделы')
  const actions = t('Действия')
  const branches = t('Ветки')
  const tabGroup = t('Вкладки')
  return [
    ...VIEWS.map((view, index): Command => ({
      id: `view-${view.id}`, title: view.id === 'requests' && forge?.kind ? requestLabel(forge.kind) : view.label, group: views, shortcut: shortcut(String(index + 1)), run: () => setView(view.id)
    })),
    { id: 'search', title: t('Найти в истории'), group: actions, shortcut: shortcut('F'), run: focusSearch },
    ...(snapshot?.remotes.length ? [{ id: 'fetch', title: 'Fetch', group: actions, run: fetchNow }] : []),
    ...(status?.upstream ? [{ id: 'pull', title: 'Pull…', group: actions, run: () => show(<PullDialog />) }] : []),
    ...(status?.head ? [{ id: 'push', title: 'Push…', group: actions, run: () => show(<PushDialog branch={status.head!} />) }] : []),
    { id: 'branch', title: t('Новая ветка…'), group: actions, run: () => show(<NewBranchDialog />) },
    ...(canRequest ? [{ id: 'request', title: t('Создать {label}…', { label: requestLabel(forge?.kind ?? null) }), group: actions, run: () => show(<CreateRequestDialog />) }] : []),
    ...(status?.files.length ? [{ id: 'stash', title: t('Сохранить правки в stash…'), group: actions, run: () => show(<NewStashDialog />) }] : []),
    ...(lastApplied ? [{
      id: 'undo', title: t('Отменить последнюю правку истории'), group: actions, shortcut: shortcut('Z'),
      run: () => void run(t('Отменяю'), () => client.undoEntry(lastApplied.id))
    }] : []),
    { id: 'signing', title: t('Подпись коммитов…'), group: actions, run: () => show(<SigningDialog />) },
    { id: 'settings', title: t('Настройки'), group: actions, shortcut: shortcut(','), run: () => show(<SettingsDialog onClose={close} />) },
    ...(snapshot?.refs ?? [])
      .filter((ref) => ref.kind === 'branch' && !ref.isHead)
      .map((ref): Command => ({
        id: `checkout-${ref.name}`, title: t('Перейти на ветку {name}', { name: ref.name }), group: branches,
        run: () => void run(t('Переключаюсь'), () => client.checkout(ref.name))
      })),
    { id: 'new-tab', title: t('Новая вкладка'), group: tabGroup, shortcut: shortcut('T'), run: add },
    { id: 'close-tab', title: t('Закрыть вкладку'), group: tabGroup, run: () => closeTab(activeId) },
    ...tabs.filter((tab) => tab.id !== activeId).map((tab): Command => ({
      id: `tab-${tab.id}`, title: t('Перейти во вкладку {name}', { name: tab.repo ? baseName(tab.repo) : t('Новая вкладка') }), group: tabGroup,
      run: () => select(tab.id)
    }))
  ]
}

export function CommandPalette({ focusSearch }: { focusSearch: () => void }): ReactNode {
  const { close } = useDialogs()
  const commands = useCommands(focusSearch)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const found = useMemo(() => filterCommands(commands, query), [commands, query])
  const chosen = Math.min(index, Math.max(found.length - 1, 0))
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [chosen])

  const runCommand = (command: Command | undefined): void => {
    if (!command) return
    // Closing first lets a command open its own dialog in the palette's place.
    close()
    command.run()
  }

  return (
    <div className="modal-scrim palette-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Команды')}>
        <label className="palette-input">
          <Icon name="search" size={15} />
          <input
            autoFocus
            value={query}
            placeholder={t('Что сделать?')}
            aria-label={t('Команда')}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setIndex((chosen + step + found.length) % Math.max(found.length, 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                runCommand(found[chosen])
              } else if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
          />
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {found.length === 0 && <div className="palette-empty">{t('Ничего не нашлось')}</div>}
          {found.map((command, position) => (
            <div key={command.id}>
              {(position === 0 || found[position - 1].group !== command.group) && <div className="palette-group">{command.group}</div>}
              <div
                role="option"
                aria-selected={position === chosen}
                className={`palette-item ${position === chosen ? 'active' : ''}`}
                onMouseMove={() => { if (position !== chosen) setIndex(position) }}
                onClick={() => runCommand(command)}
              >
                <span className="truncate">{command.title}</span>
                {command.shortcut && <kbd>{command.shortcut}</kbd>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
