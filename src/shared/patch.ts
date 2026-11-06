import type { DiffHunk, FileDiff } from './types'

function hunkText(hunk: DiffHunk): string[] {
  const lines = [hunk.header]
  for (const line of hunk.lines) {
    const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'note' ? '\\' : ' '
    lines.push(`${prefix}${line.text}`)
  }
  return lines
}

/** A patch `git apply --recount` accepts, holding the chosen hunks of one file. */
export function buildFilePatch(file: FileDiff, hunkIndexes: number[]): string {
  const lines = [...file.header]
  for (const index of hunkIndexes) lines.push(...hunkText(file.hunks[index]))
  return `${lines.join('\n')}\n`
}

export interface HunkSelection {
  file: FileDiff
  /** Hunk indexes; an empty list selects a change with no hunks, such as a pure rename. */
  hunks: number[]
}

export function buildPatch(selections: HunkSelection[]): string {
  return selections.map((selection) => buildFilePatch(selection.file, selection.hunks)).join('')
}

export type ConflictSegment =
  | { kind: 'text'; text: string }
  | { kind: 'conflict'; ours: string; base?: string; theirs: string; oursLabel: string; theirsLabel: string }

/** Splits text with conflict markers into plain runs and conflicts. */
export function parseConflictMarkers(text: string): ConflictSegment[] {
  const segments: ConflictSegment[] = []
  const lines = text.split(/(?<=\n)/)
  let plain = ''
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('<<<<<<< ')) {
      plain += lines[i]
      continue
    }
    const sections = { ours: '', base: undefined as string | undefined, theirs: '' }
    const oursLabel = lines[i].slice(8).trim()
    let theirsLabel = ''
    let section: 'ours' | 'base' | 'theirs' = 'ours'
    let closed = false
    let j = i + 1
    for (; j < lines.length; j++) {
      const line = lines[j]
      if (section === 'ours' && line.startsWith('||||||| ')) {
        section = 'base'
        sections.base = ''
      } else if (section !== 'theirs' && /^=======\r?\n?$/.test(line)) {
        section = 'theirs'
      } else if (section === 'theirs' && line.startsWith('>>>>>>> ')) {
        theirsLabel = line.slice(8).trim()
        closed = true
        break
      } else {
        sections[section] = (sections[section] ?? '') + line
      }
    }
    if (!closed) {
      plain += lines[i]
      continue
    }
    if (plain) segments.push({ kind: 'text', text: plain })
    plain = ''
    segments.push({ kind: 'conflict', ours: sections.ours, base: sections.base, theirs: sections.theirs, oursLabel, theirsLabel })
    i = j
  }
  if (plain) segments.push({ kind: 'text', text: plain })
  return segments
}

export function hasConflictMarkers(text: string): boolean {
  return parseConflictMarkers(text).some((segment) => segment.kind === 'conflict')
}
