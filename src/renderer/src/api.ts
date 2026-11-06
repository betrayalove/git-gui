import type { ApiMethod, AppApi, ChronicleBridge, RepoClient } from '../../main/api'

declare global {
  interface Window {
    chronicle: ChronicleBridge
  }
}

export const platform = window.chronicle.platform

export const appApi = new Proxy({} as AppApi, {
  get: (_target, method: string) => (...args: unknown[]) => window.chronicle.app(method, ...args)
})

/** Calls core functions over IPC with the repository path bound as the first argument. */
export function repoClient(repo: string): RepoClient {
  return new Proxy({} as RepoClient, {
    get: (_target, method: ApiMethod) => (...args: unknown[]) => window.chronicle.call(method, repo, ...args)
  })
}
