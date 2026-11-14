import { describe, expect, it } from 'vitest'
import { grammarFor, highlightLines } from '../src/renderer/src/syntax'
import { splitRows } from '../src/shared/diff-rows'
import { imageType } from '../src/shared/images'
import type { DiffHunk, DiffLine } from '../src/shared/types'

const hunk = (spec: string): DiffHunk => ({
  header: '@@ -1 +1 @@',
  lines: spec.split(' ').map((code): DiffLine => ({
    type: code[0] === '+' ? 'add' : code[0] === '-' ? 'del' : code[0] === '\\' ? 'note' : 'context',
    text: code.slice(1)
  }))
})

describe('two-column layout', () => {
  it('pairs removed lines with added ones and keeps context on both sides', () => {
    expect(splitRows(hunk('=a -b -c +B =d'))).toEqual([
      { left: 0, right: 0 },
      { left: 1, right: 3 },
      { left: 2, right: undefined },
      { left: 4, right: 4 }
    ])
  })

  it('lets the longer side of a change run on alone', () => {
    expect(splitRows(hunk('-a +A +B +C'))).toEqual([
      { left: 0, right: 1 },
      { left: undefined, right: 2 },
      { left: undefined, right: 3 }
    ])
  })

  it('keeps a missing newline note under the line it describes', () => {
    expect(splitRows(hunk('-a \\x +A'))).toEqual([
      { left: 0, right: 2 },
      { left: 1, right: undefined }
    ])
  })
})

describe('syntax colours', () => {
  it('knows languages by extension and by file name', () => {
    expect(grammarFor('src/app.tsx')).not.toBeNull()
    expect(grammarFor('docker/Dockerfile')).not.toBeNull()
    expect(grammarFor('notes.unknown')).toBeNull()
    expect(grammarFor('Makefile')).toBeNull()
  })

  it('colours a comment on every line it spans and keeps the text intact', () => {
    const lines = ['const a = 1 /* start', 'still comment */ + 2']
    const colored = highlightLines(lines, grammarFor('a.ts')!)!
    expect(colored.map((line) => line.map((segment) => segment.text).join(''))).toEqual(lines)
    expect(colored[0].find((segment) => segment.text === 'const')?.kind).toBe('keyword')
    expect(colored[1][0]).toEqual({ text: 'still comment */', kind: 'comment' })
  })

  it('keeps empty lines in place', () => {
    expect(highlightLines(['a', '', 'b'], grammarFor('a.py')!)).toHaveLength(3)
  })

  it('gives up on very long lines, such as minified code', () => {
    expect(highlightLines(['x'.repeat(5000)], grammarFor('a.js')!)).toBeNull()
  })
})

describe('images', () => {
  it('recognises pictures a browser can show by their extension', () => {
    expect(imageType('assets/Logo.PNG')).toBe('image/png')
    expect(imageType('photo.jpeg')).toBe('image/jpeg')
    expect(imageType('icon.svg')).toBeNull()
    expect(imageType('.png')).toBeNull()
    expect(imageType('archive.zip')).toBeNull()
  })
})
