import { contextBridge, ipcRenderer } from 'electron'

type Reply = { ok: true; value: unknown } | { ok: false; error: string }

async function invoke(channel: string, method: string, args: unknown[]): Promise<unknown> {
  const reply = (await ipcRenderer.invoke(channel, method, args)) as Reply
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

contextBridge.exposeInMainWorld('chronicle', {
  platform: process.platform,
  call: (method: string, ...args: unknown[]) => invoke('chronicle:repo', method, args),
  app: (method: string, ...args: unknown[]) => invoke('chronicle:app', method, args),
  onChanged: (listener: (repo: string) => void) => {
    const handler = (_event: unknown, repo: string): void => listener(repo)
    ipcRenderer.on('chronicle:changed', handler)
    return () => ipcRenderer.removeListener('chronicle:changed', handler)
  }
})
