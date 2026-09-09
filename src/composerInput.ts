import type { ExtensionInvocation } from './extensionInvocations'

export interface ComposerQuery { trigger: '/' | '@'; start: number; end: number; text: string }

export function composerQuery(text: string, caret: number): ComposerQuery | undefined {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)([/@])([^\s/@]*)$/u.exec(before)
  if (!match) return undefined
  return { trigger: match[1] as '/' | '@', start: caret - match[2].length - 1, end: caret, text: match[2].toLocaleLowerCase() }
}

export function splitComposerPrompt(prompt: string): { tokens: string[]; text: string } {
  const tokens: string[] = []
  let text = prompt
  for (;;) {
    const match = /^(\/(?:kit|skill):\S+)(?:\s+|$)/u.exec(text)
    if (!match) return { tokens, text }
    tokens.push(match[1]); text = text.slice(match[0].length)
  }
}

export function joinComposerPrompt(tokens: string[], text: string): string { return tokens.length ? `${tokens.join(' ')} ${text}` : text }

export function selectComposerInvocation(prompt: string, invocation: ExtensionInvocation, query?: ComposerQuery): string {
  const { tokens, text } = splitComposerPrompt(prompt)
  const coordinate = (token: string) => token.split(':').slice(0, 2).join(':')
  const existing = tokens.findIndex((token) => coordinate(token) === coordinate(invocation.token))
  if (existing >= 0) tokens[existing] = invocation.token
  else if (tokens.length < 8) tokens.push(invocation.token)
  return joinComposerPrompt(tokens, query ? text.slice(0, query.start) + text.slice(query.end) : text)
}

export function removeComposerQuery(text: string, query: ComposerQuery): string { return text.slice(0, query.start) + text.slice(query.end) }
