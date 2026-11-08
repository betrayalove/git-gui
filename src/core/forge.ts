import { kindForHost, parseRemoteUrl, webUrlFor } from '../shared/remote-url'
import type { ForgeContext, RemoteInfo } from '../shared/types'
import { gitLine } from './git'
import { readRemotes } from './read'

/** The stored URL, unlike `git remote -v`, is not affected by insteadOf rules. */
async function rawRemoteUrl(cwd: string, remote: string): Promise<string> {
  return gitLine(cwd, ['config', '--get', `remote.${remote}.url`])
}

/**
 * What the remote's address says about its server. Null for local paths and no remote. `known`
 * saves reading the remotes again when the caller already has them.
 */
export async function forgeContext(cwd: string, remote?: string, known?: RemoteInfo[]): Promise<ForgeContext | null> {
  const remotes = known ?? await readRemotes(cwd)
  const name = remote ?? remotes.find((entry) => entry.name === 'origin')?.name ?? remotes[0]?.name
  if (!name) return null
  const url = await rawRemoteUrl(cwd, name)
  const parsed = parseRemoteUrl(url)
  if (!parsed) return null
  return { kind: kindForHost(parsed.host), host: parsed.host, path: parsed.path, webUrl: webUrlFor(parsed), remote: name, url }
}
