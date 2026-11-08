import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { language, languageForLocale, plural, setLanguage, t, translateRecord } from '../src/shared/i18n'
import { EN } from '../src/shared/i18n-en'

const SRC = join(__dirname, '..', 'src')
const CYRILLIC = /[А-Яа-яЁё]/
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.startsWith('i18n') ? [path] : []
  })
}

function unescape(text: string): string {
  return text.replace(/\\(.)/g, (_, char: string) => (char === 'n' ? '\n' : char))
}

/** Every text the code translates: the first argument of t() and the word forms given to plural(). */
function usedKeys(): Map<string, string> {
  const keys = new Map<string, string>()
  for (const path of sourceFiles(SRC)) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(new RegExp(String.raw`\bt\(${LITERAL}`, 'g'))) keys.set(unescape(match[1]), relative(SRC, path))
    const forms = new RegExp(String.raw`\bplural\([^,]+,\s*${LITERAL},\s*${LITERAL},\s*${LITERAL}\)`, 'g')
    for (const match of source.matchAll(forms)) {
      keys.set(unescape(match[1]), relative(SRC, path))
      keys.set(unescape(match[3]), relative(SRC, path))
    }
  }
  return keys
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{\w+\}/g)].map((match) => match[0]).sort()

describe('translations', () => {
  afterEach(() => setLanguage('ru'))

  it('has an English text for every text the code translates', () => {
    const missing = [...usedKeys()].filter(([key]) => !(key in EN)).map(([key, file]) => `${file}: ${key}`)
    expect(missing).toEqual([])
  })

  it('keeps no English text that nothing uses', () => {
    const used = usedKeys()
    expect(Object.keys(EN).filter((key) => !used.has(key))).toEqual([])
  })

  it('keeps the same placeholders in both languages', () => {
    const differ = Object.entries(EN).filter(([ru, en]) => placeholders(ru).join() !== placeholders(en).join())
    expect(differ).toEqual([])
  })

  it('leaves no Russian text outside t() and plural()', () => {
    const left: string[] = []
    for (const path of sourceFiles(SRC)) {
      readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
        if (line.includes('i18n-ignore')) return
        const code = line
          .replace(new RegExp(String.raw`\bt\(${LITERAL}`, 'g'), '')
          .replace(new RegExp(String.raw`\bplural\([^)]*\)`, 'g'), '')
          .replace(/\/\/.*$/, '')
          .replace(/^\s*\*.*$/, '')
        if (CYRILLIC.test(code)) left.push(`${relative(SRC, path)}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(left).toEqual([])
  })

  it('fills in values and falls back to Russian for an unknown text', () => {
    setLanguage('en')
    expect(t('Ветка не найдена: {branch}', { branch: 'main' })).toBe('Branch not found: main')
    expect(t('Текст, которого нет в словаре')).toBe('Текст, которого нет в словаре')
    setLanguage('ru')
    expect(t('Ветка не найдена: {branch}', { branch: 'main' })).toBe('Ветка не найдена: main')
  })

  it('reads back records saved in Russian through the templates that wrote them', () => {
    setLanguage('en')
    expect(translateRecord('Перенос main поверх origin/main')).toBe('Moving main onto origin/main')
    expect(translateRecord('Отмена правки: Перенос ветки feature на main')).toBe('Undo of edit: Moving branch feature onto main')
    expect(translateRecord('правка коммитов: 2, перестройка ветки main')).toBe('commit edits: 2, rebuilding branch main')
    expect(translateRecord('Свой текст без шаблона')).toBe('Свой текст без шаблона')
    setLanguage('ru')
    expect(translateRecord('Перенос main поверх origin/main')).toBe('Перенос main поверх origin/main')
  })

  it('picks word forms for each language', () => {
    expect([1, 3, 5, 21].map((count) => plural(count, 'коммит', 'коммита', 'коммитов'))).toEqual(['1 коммит', '3 коммита', '5 коммитов', '21 коммит'])
    setLanguage('en')
    expect([1, 3, 21].map((count) => plural(count, 'коммит', 'коммита', 'коммитов'))).toEqual(['1 commit', '3 commits', '21 commits'])
  })

  it('starts in Russian and picks a first language from the system locale', () => {
    expect(language()).toBe('ru')
    expect(languageForLocale('ru-RU')).toBe('ru')
    expect(languageForLocale('en-US')).toBe('en')
    expect(languageForLocale('de')).toBe('en')
  })
})
