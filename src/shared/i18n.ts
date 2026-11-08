import { EN } from './i18n-en'

export type Language = 'ru' | 'en'

export const LANGUAGES: Language[] = ['ru', 'en']

interface Bridge {
  chronicle?: { language?: string }
}

function initialLanguage(): Language {
  // The window learns its language before any module runs, so texts kept in constants are translated too.
  const fromBridge = (globalThis as Bridge).chronicle?.language
  return fromBridge === 'en' ? 'en' : 'ru'
}

let current: Language = initialLanguage()

export function setLanguage(language: Language): void {
  current = language
}

export function language(): Language {
  return current
}

export function isLanguage(value: unknown): value is Language {
  return value === 'ru' || value === 'en'
}

/** The language for a system locale such as `ru-RU` or `en-US`, for a first start. */
export function languageForLocale(locale: string): Language {
  return /^(ru|be|uk|kk)\b/i.test(locale) ? 'ru' : 'en'
}

/**
 * Translates a text. The Russian text is the source and the key, so code reads the same as the
 * interface. `{name}` in the text is replaced with `params.name`.
 */
export function t(text: string, params?: Record<string, string | number | null | undefined>): string {
  const template = current === 'en' ? EN[text] ?? text : text
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => (name in params ? String(params[name] ?? '') : match))
}

interface Template {
  pattern: RegExp
  names: string[]
  english: string
}

let templates: Template[] | null = null

/** The texts with placeholders, longest literal part first, as patterns that read a filled-in text back. */
function recordTemplates(): Template[] {
  templates ??= Object.entries(EN)
    .filter(([russian]) => /\{\w+\}/.test(russian))
    .sort(([a], [b]) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length)
    .map(([russian, english]) => {
      const names: string[] = []
      const source = russian.split(/(\{\w+\})/).map((part) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1]
        if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        names.push(name)
        return '([\\s\\S]+?)'
      }).join('')
      return { pattern: new RegExp(`^${source}$`), names, english }
    })
  return templates
}

function translateOne(text: string): string | null {
  if (text in EN) return EN[text]
  for (const template of recordTemplates()) {
    const match = template.pattern.exec(text)
    if (!match) continue
    const values = Object.fromEntries(template.names.map((name, index) => [name, translateRecord(match[index + 1])]))
    return template.english.replace(/\{(\w+)\}/g, (whole: string, name: string) => values[name] ?? whole)
  }
  return null
}

/**
 * Translates a text that was saved in the language of its day, such as a journal entry. It is read
 * back through the same templates that produced it. A text no template explains stays as it is.
 */
export function translateRecord(text: string): string {
  if (current === 'ru' || !/[А-Яа-яЁё]/.test(text)) return text
  const whole = translateOne(text)
  if (whole !== null && !/[А-Яа-яЁё]/.test(whole)) return whole
  // A plan description joins several parts with commas.
  const parts = text.split(', ').map(translateOne)
  if (parts.every((part) => part !== null)) return parts.join(', ')
  return whole ?? text
}

/** A count with the word in the right form: three Russian forms, two English ones. */
export function plural(count: number, one: string, few: string, many: string): string {
  if (current === 'en') return `${count} ${count === 1 ? t(one) : t(many)}`
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} ${one}`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} ${few}`
  return `${count} ${many}`
}

/** The locale tag for dates and numbers. */
export function locale(): string {
  return current === 'en' ? 'en' : 'ru'
}
