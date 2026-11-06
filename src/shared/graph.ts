export interface GraphRow {
  column: number
  color: number
  /** Lanes passing straight through this row. */
  through: { column: number; color: number }[]
  /** Lanes that end at this row's node, coming from above. */
  into: { column: number; color: number }[]
  /** Lanes leaving this row's node, going below. */
  out: { column: number; color: number }[]
  width: number
}

export interface GraphInput {
  sha: string
  parents: string[]
}

const PALETTE_SIZE = 8

/** Assigns each commit a lane. Input must be topologically ordered, newest first. */
export function layoutGraph(commits: GraphInput[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  const free = (): number => {
    const index = lanes.indexOf(null)
    return index === -1 ? lanes.length : index
  }
  const rows: GraphRow[] = []
  for (const commit of commits) {
    let column = lanes.indexOf(commit.sha)
    const isNew = column === -1
    if (isNew) {
      column = free()
      lanes[column] = commit.sha
      colors[column] = nextColor++ % PALETTE_SIZE
    }
    const into: GraphRow['into'] = []
    const through: GraphRow['through'] = []
    lanes.forEach((sha, index) => {
      if (sha === null) return
      if (sha === commit.sha) {
        if (!(isNew && index === column)) into.push({ column: index, color: colors[index] })
      } else {
        through.push({ column: index, color: colors[index] })
      }
    })
    for (const entry of into) if (entry.column !== column) lanes[entry.column] = null
    const color = colors[column]
    const out: GraphRow['out'] = []
    lanes[column] = null
    commit.parents.forEach((parent, index) => {
      // The first parent keeps this lane even if another lane already waits for it. The lanes
      // meet at the parent's row, which keeps a long-lived branch straight on the left.
      if (index === 0) {
        lanes[column] = parent
        out.push({ column, color })
        return
      }
      const existing = lanes.indexOf(parent)
      if (existing !== -1) {
        out.push({ column: existing, color: colors[existing] })
      } else {
        const lane = free()
        lanes[lane] = parent
        colors[lane] = nextColor++ % PALETTE_SIZE
        out.push({ column: lane, color: colors[lane] })
      }
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(
      column,
      ...into.map((entry) => entry.column),
      ...through.map((entry) => entry.column),
      ...out.map((entry) => entry.column)
    ) + 1
    rows.push({ column, color, through, into, out, width })
  }
  return rows
}

/**
 * Fits a row into a limited width. Busy histories reach hundreds of lanes. Lanes past the limit
 * are hidden, while a commit's own node and its edges stay visible at the edge.
 */
export function clampRow(row: GraphRow, maxColumns: number): GraphRow {
  if (row.width <= maxColumns) return row
  const last = maxColumns - 1
  const clamp = (lane: { column: number; color: number }): { column: number; color: number } =>
    lane.column > last ? { ...lane, column: last } : lane
  return {
    ...row,
    column: Math.min(row.column, last),
    through: row.through.filter((lane) => lane.column <= last),
    into: row.into.filter((lane) => lane.column <= last),
    out: row.out.map(clamp),
    width: maxColumns
  }
}
