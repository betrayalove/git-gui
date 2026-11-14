export interface Command {
  id: string
  title: string
  group: string
  shortcut?: string
  run: () => void
}

/**
 * The commands whose group and title hold every word typed, in any order and case. Titles that
 * start with the text come first, then those with a word that starts with it; otherwise the
 * order stays as given.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const text = query.trim().toLowerCase()
  if (!text) return commands
  const words = text.split(/\s+/)
  const rank = (command: Command): number => {
    const title = command.title.toLowerCase()
    if (title.startsWith(text)) return 0
    return title.split(/[\s/.-]+/).some((word) => word.startsWith(words[0])) ? 1 : 2
  }
  return commands
    .filter((command) => {
      const haystack = `${command.group} ${command.title}`.toLowerCase()
      return words.every((word) => haystack.includes(word))
    })
    .map((command, index) => ({ command, index, rank: rank(command) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.command)
}
