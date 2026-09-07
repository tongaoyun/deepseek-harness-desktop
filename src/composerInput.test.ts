import { expect, it } from 'vitest'
import { composerQuery, joinComposerPrompt, selectComposerInvocation, splitComposerPrompt } from './composerInput'

it('finds slash and at queries at the caret, not just the start of the prompt', () => {
  expect(composerQuery('帮我 /周报 汇总一下', 6)).toEqual({ trigger: '/', start: 3, end: 6, text: '周报' })
  expect(composerQuery('参考 @资料', 6)).toMatchObject({ trigger: '@', text: '资料' })
  expect(composerQuery('hello@example.com', 17)).toBeUndefined()
  expect(composerQuery('https://example.com', 19)).toBeUndefined()
})
it('replaces only the query and keeps a single executable capability prefix', () => {
  const item = { id: 'report', token: '/skill:report', name: '周报', description: '', kind: 'skill' as const }
  const original = '/kit:old 帮我 /周报 汇总一下'
  const query = composerQuery(splitComposerPrompt(original).text, 6)
  expect(selectComposerInvocation(original, item, query)).toBe('/skill:report 帮我  汇总一下')
  expect(splitComposerPrompt('/skill:report ')).toEqual({ token: '/skill:report', text: '' })
  expect(joinComposerPrompt('', '正文不丢')).toBe('正文不丢')
})
