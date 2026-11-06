import type { UpdateInfo } from '../shared/types'

const RELEASES_URL = 'https://api.github.com/repos/betrayalove/git-gui/releases/latest'
const TIMEOUT_MS = 10_000

/** Compares dotted versions numerically. A pre-release tag sorts before its release. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): { numbers: number[]; pre: boolean } => {
    const [core, pre] = version.replace(/^v/, '').split('-')
    return { numbers: core.split('.').map((part) => Number(part) || 0), pre: Boolean(pre) }
  }
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i++) {
    const difference = (a.numbers[i] ?? 0) - (b.numbers[i] ?? 0)
    if (difference) return difference > 0
  }
  return b.pre && !a.pre
}

/** Only looks. It installs nothing, because unsigned builds cannot update themselves on macOS. */
export async function checkForUpdate(current: string, url: string = RELEASES_URL): Promise<UpdateInfo> {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Chronicle' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (response.status === 404) return { current, latest: null, available: false, url: null }
  if (!response.ok) throw new Error(`Не удалось проверить обновления: ошибка ${response.status}`)
  const release = (await response.json()) as { tag_name?: string; html_url?: string }
  const latest = release.tag_name?.replace(/^v/, '') ?? null
  const page = release.html_url?.startsWith('https://') ? release.html_url : null
  return { current, latest, available: Boolean(latest && page && isNewerVersion(latest, current)), url: page }
}
