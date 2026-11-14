import type { DiffHunk } from './types'

/** One row of a two-column diff: indexes into `hunk.lines` for the old and the new side. */
export interface SplitRow {
  left?: number
  right?: number
}

/**
 * Lays a hunk out in two columns. Context lines sit on both sides; in each run of changes the
 * removed lines are paired with the added ones in order, and the longer side runs on alone.
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  let removed: number[] = []
  let added: number[] = []
  const flush = (): void => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ left: removed[index], right: added[index] })
    }
    removed = []
    added = []
  }
  let previous: 'context' | 'add' | 'del' = 'context'
  hunk.lines.forEach((line, index) => {
    if (line.type === 'del') {
      removed.push(index)
    } else if (line.type === 'add') {
      added.push(index)
    } else if (line.type === 'note' && previous !== 'context') {
      // "\ No newline at end of file" stays under the line it describes.
      const side = previous === 'del' ? removed : added
      side.push(index)
      return
    } else {
      flush()
      rows.push({ left: index, right: index })
    }
    if (line.type !== 'note') previous = line.type
  })
  flush()
  return rows
}
