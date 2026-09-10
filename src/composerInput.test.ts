import { expect, it } from 'vitest'
import { composerQuery, joinComposerPrompt, selectComposerInvocation, splitComposerPrompt } from './composerInput'

it('finds slash and at queries at the caret, not just the start of the prompt', () => {
  expect(composerQuery('帮我 /周报 汇总一下', 6)).toEqual({ trigger: '/', start: 3, end: 6, text: '周报' })
  expect(composerQuery('参考 @资料', 6)).toMatchObject({ trigger: '@', text: '资料' })
  expect(composerQuery('hello@example.com', 17)).toBeUndefined()
  expect(composerQuery('https://example.com', 19)).toBeUndefined()
})
it('adds another capability while preserving the text and existing selection', () => {
  const item = { id: 'report', token: '/skill:report', name: '周报', description: '', kind: 'skill' as const,
    spec: { mode: 'explicit' as const, kind: 'skill' as const, extensionId: 'report', extensionVersion: '1.0.0', skillId: 'report' } }
  const original = '/kit:old 帮我 /周报 汇总一下'
  const query = composerQuery(splitComposerPrompt(original).text, 6)
  expect(selectComposerInvocation(original, item, query)).toBe('/kit:old /skill:report 帮我  汇总一下')
  expect(splitComposerPrompt('/skill:report ')).toEqual({ tokens: ['/skill:report'], text: '' })
  expect(joinComposerPrompt([], '正文不丢')).toBe('正文不丢')
})
it('replaces the command of the same kit, limits selections to eight and preserves all prefixes', () => {
  const item = { id: 'reports', token: '/kit:reports:monthly', name: '月报', description: '', kind: 'expert-kit' as const,
    spec: { mode: 'explicit' as const, kind: 'expert-kit' as const, extensionId: 'reports', extensionVersion: '1.0.0', commandId: 'monthly' } }
  expect(selectComposerInvocation('/kit:reports:weekly /skill:check 正文', item)).toBe('/kit:reports:monthly /skill:check 正文')
  const tokens = Array.from({ length: 8 }, (_, index) => `/kit:kit-${index}`)
  expect(selectComposerInvocation(joinComposerPrompt(tokens, '正文'), item)).toBe(joinComposerPrompt(tokens, '正文'))
  expect(splitComposerPrompt('/kit:a\n/skill:b 正文 /普通文字')).toEqual({ tokens: ['/kit:a', '/skill:b'], text: '正文 /普通文字' })
})
