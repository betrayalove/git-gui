import { platform } from './api'

const mac = platform === 'darwin'

/** The key that goes with letters in shortcuts: Command on a Mac, Control elsewhere. */
export function isModifier(event: KeyboardEvent): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** How a shortcut is written on this system, such as ⌘K on a Mac and Ctrl+K elsewhere. */
export function shortcut(key: string): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`
}
