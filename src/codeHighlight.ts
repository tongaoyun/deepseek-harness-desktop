import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import gradle from 'highlight.js/lib/languages/gradle'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const languages = {
  bash, cpp, csharp, css, go, gradle, ini, java, javascript, json, kotlin, markdown, php, python,
  ruby, rust, scss, sql, swift, typescript, xml, yaml,
}

for (const [name, definition] of Object.entries(languages)) hljs.registerLanguage(name, definition)

const aliases: Record<string, string> = {
  c: 'cpp', cc: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  cs: 'csharp', htm: 'xml', html: 'xml', js: 'javascript', jsx: 'javascript',
  kt: 'kotlin', kts: 'kotlin', md: 'markdown', py: 'python', rb: 'ruby',
  rs: 'rust', sh: 'bash', ts: 'typescript', tsx: 'typescript', vue: 'xml',
  yml: 'yaml', properties: 'ini', toml: 'ini',
}

export function highlightedCode(code: string, language?: string): string {
  const normalized = normalizeLanguage(language)
  if (!normalized || !hljs.getLanguage(normalized)) return escapeHtml(code)
  return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
}

export function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined
  const normalized = language.toLocaleLowerCase('en-US')
  return aliases[normalized] ?? normalized
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
