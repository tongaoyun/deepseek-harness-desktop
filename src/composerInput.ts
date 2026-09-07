import type { ExtensionInvocation } from './extensionInvocations'

export interface ComposerQuery { trigger: '/' | '@'; start: number; end: number; text: string }

export function composerQuery(text: string, caret: number): ComposerQuery | undefined {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)([/@])([^\s/@]*)$/u.exec(before)
  if (!match) return undefined
  return { trigger: match[1] as '/' | '@', start: caret - match[2].length - 1, end: caret, text: match[2].toLocaleLowerCase() }
}

export function splitComposerPrompt(prompt: string): { token: string; text: string } {
  const match = /^(\/(?:kit|skill):\S+)(?:\s|$)/u.exec(prompt)
  return match ? { token: match[1], text: prompt.slice(match[0].length) } : { token: '', text: prompt }
}

export function joinComposerPrompt(token: string, text: string): string { return token ? `${token} ${text}` : text }

export function selectComposerInvocation(prompt: string, invocation: ExtensionInvocation, query?: ComposerQuery): string {
  const { text } = splitComposerPrompt(prompt)
  return joinComposerPrompt(invocation.token, query ? text.slice(0, query.start) + text.slice(query.end) : text)
}

export function removeComposerQuery(text: string, query: ComposerQuery): string { return text.slice(0, query.start) + text.slice(query.end) }
