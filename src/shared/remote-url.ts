import type { ForgeContext, ForgeKind } from './types'

export interface ParsedRemote {
  host: string
  path: string
  protocol: 'ssh' | 'https' | 'http'
  /** SSH user, when the address names one. */
  user?: string
  /** SSH port, when it is not the standard one. */
  port?: number
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
  const scp = /^(?:([^@/\s]+)@)?([^:/\s]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(url)
  if (scp && !/^[a-zA-Z]:[\\/]/.test(url)) {
    return { host: scp[2].toLowerCase(), path: scp[3], protocol: 'ssh', ...(scp[1] ? { user: scp[1] } : {}) }
  }
  try {
    const parsed = new URL(url)
    if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return null
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
    if (!path.includes('/')) return null
    if (parsed.protocol === 'ssh:') {
      // The SSH port differs from the web port, so it is not part of the host identity.
      return {
        host: parsed.hostname.toLowerCase(), path, protocol: 'ssh',
        ...(parsed.username ? { user: decodeURIComponent(parsed.username) } : {}),
        ...(parsed.port ? { port: Number(parsed.port) } : {})
      }
    }
    return { host: parsed.host.toLowerCase(), path, protocol: parsed.protocol === 'https:' ? 'https' : 'http' }
  } catch {
    return null
  }
}

/** Without an account the server type can only be read from its name. */
export function kindForHost(host: string): ForgeKind | null {
  const name = host.split(':')[0]
  if (/(^|\.)github\./.test(name)) return 'github'
  if (/(^|\.)gitlab\./.test(name)) return 'gitlab'
  return null
}

export function webUrlFor(parsed: ParsedRemote): string {
  return `${parsed.protocol === 'http' ? 'http' : 'https'}://${parsed.host}/${parsed.path}`
}

export function requestLabel(kind: ForgeKind | null): string {
  return kind === 'gitlab' ? 'Merge Request' : 'Pull Request'
}

function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

export function requestsPageUrl(forge: ForgeContext): string | null {
  if (forge.kind === 'github') return `${forge.webUrl}/pulls`
  if (forge.kind === 'gitlab') return `${forge.webUrl}/-/merge_requests`
  return null
}

export function newRequestUrl(forge: ForgeContext, branch: string): string | null {
  if (forge.kind === 'github') return `${forge.webUrl}/compare/${encodeBranch(branch)}?expand=1`
  if (forge.kind === 'gitlab') return `${forge.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`
  return null
}

export function branchSettingsUrl(forge: ForgeContext): string | null {
  if (forge.kind === 'github') return `${forge.webUrl}/settings/branches`
  if (forge.kind === 'gitlab') return `${forge.webUrl}/-/settings/repository`
  return null
}

export function defaultBranchSettingsUrl(forge: ForgeContext): string | null {
  if (forge.kind === 'github') return `${forge.webUrl}/settings`
  if (forge.kind === 'gitlab') return `${forge.webUrl}/-/settings/repository`
  return null
}

/** The page where a token with the rights the app needs is made: repo on GitHub, api on GitLab. */
export function tokenPageUrl(kind: ForgeKind, host: string): string {
  if (kind === 'github') return `https://${host}/settings/tokens/new?scopes=repo&description=Chronicle`
  return `https://${host}/-/user_settings/personal_access_tokens?name=Chronicle&scopes=api`
}
