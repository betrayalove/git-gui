const queues = new Map<string, Promise<unknown>>()

/**
 * Runs actions that share a key one after another. A file that is read, changed and written back
 * needs this: two such updates at once would each write their own copy and lose the other's.
 * Only one copy of the app runs, so a queue in memory is enough.
 */
export async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(action)
  const settled = current.catch(() => {})
  queues.set(key, settled)
  try {
    return await current
  } finally {
    if (queues.get(key) === settled) queues.delete(key)
  }
}
