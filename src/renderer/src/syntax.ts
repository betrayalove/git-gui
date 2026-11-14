import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-jsx'
import 'prismjs/components/prism-tsx'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-scss'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-rust'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-kotlin'
import 'prismjs/components/prism-swift'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-ruby'
import 'prismjs/components/prism-markup-templating'
import 'prismjs/components/prism-php'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-toml'
import 'prismjs/components/prism-markdown'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-ini'
import 'prismjs/components/prism-docker'

export type SyntaxKind = 'comment' | 'string' | 'keyword' | 'number' | 'function' | 'type' | 'tag' | 'property' | 'punctuation'

export interface Segment {
  text: string
  kind?: SyntaxKind
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', css: 'css', scss: 'scss',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', plist: 'markup',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', md: 'markdown', sql: 'sql', ini: 'ini', cfg: 'ini'
}

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'docker', gemfile: 'ruby', rakefile: 'ruby', '.gitconfig': 'ini', '.editorconfig': 'ini'
}

const KIND: Record<string, SyntaxKind> = {
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment',
  string: 'string', char: 'string', 'template-string': 'string', 'attr-value': 'string', regex: 'string', url: 'string',
  keyword: 'keyword', atrule: 'keyword', important: 'keyword', rule: 'keyword', boolean: 'number',
  number: 'number', constant: 'number', symbol: 'number', entity: 'number',
  function: 'function', 'function-variable': 'function', macro: 'function',
  'class-name': 'type', builtin: 'type', namespace: 'type',
  tag: 'tag', selector: 'tag', title: 'keyword',
  'attr-name': 'property', property: 'property', key: 'property',
  punctuation: 'punctuation', operator: 'punctuation'
}

// Highlighting is a nicety: past these sizes, such as for minified files, plain text is shown.
const MAX_TEXT = 200_000
const MAX_LINE = 2_000

export function grammarFor(path: string): Prism.Grammar | null {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  const language = LANGUAGE_BY_NAME[name] ?? (dot > 0 ? LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] : undefined)
  return language ? Prism.languages[language] ?? null : null
}

/**
 * Splits consecutive lines of one file into coloured pieces. The lines are read together,
 * so a comment or string that spans several of them keeps its colour on each.
 */
export function highlightLines(lines: string[], grammar: Prism.Grammar): Segment[][] | null {
  if (lines.some((line) => line.length > MAX_LINE)) return null
  const text = lines.join('\n')
  if (text.length > MAX_TEXT) return null
  const result: Segment[][] = [[]]
  const push = (piece: string, kind?: SyntaxKind): void => {
    piece.split('\n').forEach((part, index) => {
      if (index > 0) result.push([])
      if (part) result[result.length - 1].push(kind ? { text: part, kind } : { text: part })
    })
  }
  const walk = (stream: Prism.TokenStream, inherited?: SyntaxKind): void => {
    if (typeof stream === 'string') return push(stream, inherited)
    if (Array.isArray(stream)) return stream.forEach((item) => walk(item, inherited))
    const aliases = Array.isArray(stream.alias) ? stream.alias : stream.alias ? [stream.alias] : []
    const kind = KIND[stream.type] ?? aliases.map((alias) => KIND[alias]).find(Boolean) ?? inherited
    walk(stream.content, kind)
  }
  walk(Prism.tokenize(text, grammar))
  return result
}
