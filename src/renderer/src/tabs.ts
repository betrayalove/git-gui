import { createContext, useContext } from 'react'

export interface Tab {
  id: number
  /** Null while the tab shows the start screen. */
  repo: string | null
}

export interface TabsValue {
  tabs: Tab[]
  activeId: number
  select: (id: number) => void
  close: (id: number) => void
  add: () => void
  /** Moves to the next tab, or the previous one with a negative step, wrapping around. */
  cycle: (step: number) => void
}

export const TabsContext = createContext<TabsValue | null>(null)

export function useTabs(): TabsValue {
  const value = useContext(TabsContext)
  if (!value) throw new Error('useTabs used outside the tabs')
  return value
}
