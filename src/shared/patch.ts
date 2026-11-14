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

/**
 * A patch of one hunk that changes only the chosen lines, given as indexes into `hunk.lines`.
 * The other changed lines must look the way they are on the side the patch is applied to:
 * forwards that is the old side, so unchosen removals stay as context and unchosen additions go;
 * with `reverse` git matches the new side, so it is the other way round.
 */
export function buildLinesPatch(file: FileDiff, hunkIndex: number, lineIndexes: number[], reverse = false): string {
  const chosen = new Set(lineIndexes)
  const hunk = file.hunks[hunkIndex]
  const lines = [...file.header, hunk.header]
  // "\ No newline at end of file" belongs to the line before it and goes wherever that line goes.
  let previousKept = true
  hunk.lines.forEach((line, index) => {
    if (line.type === 'note') {
      if (previousKept) lines.push(`\\${line.text}`)
    } else if (line.type === 'context' || chosen.has(index)) {
      lines.push(`${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`)
      previousKept = true
    } else {
      previousKept = line.type === (reverse ? 'add' : 'del')
      if (previousKept) lines.push(` ${line.text}`)
    }
  })
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
