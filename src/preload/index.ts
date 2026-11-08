import { contextBridge, ipcRenderer } from 'electron'

type Reply = { ok: true; value: unknown } | { ok: false; error: string }

async function invoke(channel: string, method: string, args: unknown[]): Promise<unknown> {
  const reply = (await ipcRenderer.invoke(channel, method, args)) as Reply
  if (!reply.ok) throw new Error(reply.error)
  return reply.value
}

contextBridge.exposeInMainWorld('chronicle', {
  platform: process.platform,
  language: ipcRenderer.sendSync('chronicle:language') as string,
  call: (method: string, ...args: unknown[]) => invoke('chronicle:repo', method, args),
  app: (method: string, ...args: unknown[]) => invoke('chronicle:app', method, args),
  onChanged: (listener: (repo: string) => void) => {
    const handler = (_event: unknown, repo: string): void => listener(repo)
    ipcRenderer.on('chronicle:changed', handler)
    return () => ipcRenderer.removeListener('chronicle:changed', handler)
  },
  onPrompt: (listener: (prompt: unknown) => void) => {
    const handler = (_event: unknown, prompt: unknown): void => listener(prompt)
    ipcRenderer.on('chronicle:prompt', handler)
    return () => ipcRenderer.removeListener('chronicle:prompt', handler)
  },
  onPromptClosed: (listener: (id: string) => void) => {
    const handler = (_event: unknown, id: string): void => listener(id)
    ipcRenderer.on('chronicle:prompt-closed', handler)
    return () => ipcRenderer.removeListener('chronicle:prompt-closed', handler)
  }
})
