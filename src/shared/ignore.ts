export type IgnoreScope = 'file' | 'folder' | 'extension'

/** Makes a name match only itself: gitignore reads `*`, `?`, `[` and `\` as patterns, and drops trailing spaces. */
function literal(text: string): string {
  return text.replace(/[\\*?[]/g, (char) => `\\${char}`).replace(/ $/, '\\ ')
}

export function extensionOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : null
}

export function folderOf(path: string): string | null {
  const slash = path.replace(/\/$/, '').lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : null
}

/**
 * The .gitignore line for an untracked path: exactly that file, its folder, or every file with its
 * extension anywhere. Null when the path has no such folder or extension. The leading slash anchors
 * the line at the repository root, so `/build/` does not also hide `src/build/`.
 */
export function ignorePattern(path: string, scope: IgnoreScope): string | null {
  if (scope === 'file') return `/${literal(path.replace(/\/$/, ''))}${path.endsWith('/') ? '/' : ''}`
  if (scope === 'folder') {
    const folder = folderOf(path)
    return folder ? `/${literal(folder)}/` : null
  }
  const extension = extensionOf(path)
  return extension ? `*.${literal(extension)}` : null
}
