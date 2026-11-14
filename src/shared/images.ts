const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon'
}

/** The media type of a picture a browser can show, judged by the file name; null for anything else. */
export function imageType(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null : null
}
