export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
const fullDate = new Intl.DateTimeFormat('ru', { dateStyle: 'long', timeStyle: 'short' })
const shortDate = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' })

export function formatRelative(iso: string, now: number = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000
  const abs = Math.abs(seconds)
  if (abs < 60) return 'только что'
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour')
  if (abs < 86400 * 14) return relative.format(Math.round(seconds / 86400), 'day')
  return shortDate.format(new Date(iso))
}

export function formatFull(iso: string): string {
  return fullDate.format(new Date(iso))
}

/** The wall-clock part of an ISO date, for a datetime-local input. */
export function isoToLocalInput(iso: string): string {
  return iso.slice(0, 19)
}

export function offsetOf(iso: string): string {
  return /([+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? '+00:00'
}

export function dateToLocalInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return shifted.toISOString().slice(0, 16)
}

export function shiftIso(iso: string, hours: number): string {
  const offset = offsetOf(iso)
  const sign = offset[0] === '-' ? -1 : 1
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))
  const shifted = new Date(Date.parse(iso) + hours * 3600000 + minutes * 60000)
  return `${shifted.toISOString().slice(0, 19)}${offset}`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

export function hueOf(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return Math.abs(hash) % 360
}

export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`
  return `${count} ${many}`
}
