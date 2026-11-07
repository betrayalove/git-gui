import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SVGProps } from 'react'
import { hueOf, initials } from '../format'

const paths: Record<string, ReactNode> = {
  history: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  changes: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M9.5 13h5M12 10.5v5" /></>,
  stash: <><path d="M4 8.5h16v11H4z" /><path d="M6 4.5h12l2 4H4zM9.5 12.5h5" /></>,
  schedule: <><rect x="4" y="5.5" width="16" height="15" rx="2" /><path d="M4 10h16M8.5 3v4M15.5 3v4M12 13v3l2 1" /></>,
  journal: <><path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4l3 2" /></>,
  branch: <><circle cx="7" cy="5.5" r="2.2" /><circle cx="7" cy="18.5" r="2.2" /><circle cx="17" cy="8" r="2.2" /><path d="M7 7.7v8.6M17 10.2c0 3.8-10 2.3-10 6.1" /></>,
  tag: <><path d="M4 4.5h7.5L20 13l-7 7-9-8.5z" /><circle cx="8.5" cy="9" r="1.2" /></>,
  cloud: <path d="M7.5 18.5a4.5 4.5 0 0 1-.5-9 5.5 5.5 0 0 1 10.7 1A4 4 0 0 1 17 18.5z" />,
  fetch: <path d="M12 4v11M7.5 11 12 15.5l4.5-4.5M5 20h14" />,
  pull: <path d="M12 3.5v13M7 12l5 5 5-5M5 21h14" />,
  push: <path d="M12 20.5v-13M7 12l5-5 5 5M5 3h14" />,
  undo: <><path d="M4.5 9.5h10a5 5 0 0 1 0 10H9" /><path d="M8.5 5.5l-4 4 4 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l5 5" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  folder: <path d="M3.5 6.5h6l2 2.5h9v10h-17z" />,
  trash: <path d="M5 7h14M10 4h4M7 7l1 13h8l1-13M10.5 11v5M13.5 11v5" />,
  broom: <path d="M18.5 3.5l-6 7M9 10l5 5-3 5.5c-2.5 0-6-1-8-4 2 0 4-1.5 6-6.5z" />,
  warning: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5M12 17.2v.3" /></>,
  grip: <path d="M9 6v.1M15 6v.1M9 12v.1M15 12v.1M9 18v.1M15 18v.1" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  split: <path d="M12 3v6M12 9L6 15v6M12 9l6 6v6" />,
  merge: <><circle cx="7" cy="5.5" r="2.2" /><circle cx="7" cy="18.5" r="2.2" /><circle cx="17" cy="14" r="2.2" /><path d="M7 7.7v8.6M7 8c0 3.5 3 6 7.8 6" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>,
  file: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4" /></>,
  key: <><circle cx="8" cy="15.5" r="4.5" /><path d="M11.2 12.3L20 3.5M16 7.5l3 3M13.5 10l2 2" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.5-4 3-6 6.5-6s6 2 6.5 6M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.5c1.8.9 2.8 2.7 3 5.5" /></>
}

export function Icon({ name, size = 16, ...rest }: { name: keyof typeof paths | string; size?: number } & SVGProps<SVGSVGElement>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {paths[name]}
    </svg>
  )
}

export function Avatar({ name, email, size = 22 }: { name: string; email: string; size?: number }): ReactNode {
  const hue = hueOf(email || name)
  return (
    <span
      className="avatar"
      title={`${name} <${email}>`}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `hsl(${hue} 55% 38%)` }}
    >
      {initials(name)}
    </span>
  )
}

export function Modal({ title, onClose, children, footer, wide, extraWide, topmost }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  extraWide?: boolean
  /** Shown over another dialog: Escape closes only this one. */
  topmost?: boolean
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (topmost) event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, Boolean(topmost))
    return () => window.removeEventListener('keydown', onKey, Boolean(topmost))
  }, [onClose, topmost])
  return (
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ${extraWide ? 'modal-xl' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><Icon name="close" /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export interface MenuItem {
  label?: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  run?: () => void
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    setPosition({
      left: Math.min(x, window.innerWidth - box.width - 8),
      top: Math.min(y, window.innerHeight - box.height - 8)
    })
  }, [x, y])
  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div ref={ref} className="context-menu" style={position} role="menu" onMouseDown={(event) => event.stopPropagation()}>
      {items.map((item, index) =>
        item.separator ? <div key={index} className="menu-sep" /> : (
          <button
            key={index}
            role="menuitem"
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            disabled={item.disabled}
            onClick={() => { onClose(); item.run?.() }}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : <span style={{ width: 14 }} />}
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: string; title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  )
}
