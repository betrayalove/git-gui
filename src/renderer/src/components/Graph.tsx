import type { ReactNode } from 'react'
import type { GraphRow } from '../../../shared/graph'

export const LANE_WIDTH = 14
export const ROW_HEIGHT = 36
const PADDING = 12

function x(column: number): number {
  return PADDING + column * LANE_WIDTH
}

export function graphWidth(columns: number): number {
  return PADDING * 2 + Math.max(columns - 1, 0) * LANE_WIDTH
}

function curve(fromColumn: number, fromY: number, toColumn: number, toY: number): string {
  const [x1, x2] = [x(fromColumn), x(toColumn)]
  if (x1 === x2) return `M${x1} ${fromY}L${x2} ${toY}`
  const middle = (fromY + toY) / 2
  return `M${x1} ${fromY}C${x1} ${middle} ${x2} ${middle} ${x2} ${toY}`
}

export function GraphCell({ row, width, merge, ghost }: { row: GraphRow; width: number; merge: boolean; ghost: boolean }): ReactNode {
  const middle = ROW_HEIGHT / 2
  const nodeX = x(row.column)
  const color = `var(--lane-${row.color})`
  return (
    <svg className="graph-cell" width={width} height={ROW_HEIGHT} aria-hidden>
      {row.through.map((lane) => (
        <path key={`t${lane.column}`} d={curve(lane.column, 0, lane.column, ROW_HEIGHT)} stroke={`var(--lane-${lane.color})`} />
      ))}
      {row.into.map((lane) => (
        <path key={`i${lane.column}`} d={curve(lane.column, 0, row.column, middle)} stroke={`var(--lane-${lane.color})`} />
      ))}
      {row.out.map((lane) => (
        <path key={`o${lane.column}`} d={curve(row.column, middle, lane.column, ROW_HEIGHT)} stroke={`var(--lane-${lane.color})`} />
      ))}
      {ghost ? (
        <circle cx={nodeX} cy={middle} r={4} fill="var(--surface-1)" stroke={color} strokeDasharray="2 2" strokeWidth={1.5} />
      ) : merge ? (
        <circle cx={nodeX} cy={middle} r={3.5} fill={color} stroke="var(--surface-1)" strokeWidth={1.5} />
      ) : (
        <circle cx={nodeX} cy={middle} r={5} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
      )}
    </svg>
  )
}
