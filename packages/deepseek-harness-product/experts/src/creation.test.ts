import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDrafts } from './creation.ts'
import { matchMember, renderDraft } from './creation-contract.ts'
import type { ExpertSummary } from './expert-contract.ts'
const expert = { name: '审查专家', description: '审查代码', division: 'engineering', prompt: 'Read code and report actionable findings.' }
const member = (slug: string, name: string, nameEn: string): ExpertSummary => ({ slug, name, nameEn, description: '', descriptionEn: '', emoji: '🧩', division: 'engineering', divisionZh: '工程', custom: false })

it.each(['backward', 'forward'] as const)('keeps creation confirmation lifetime independent of a %s wall-clock jump', (direction) => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-27T08:00:00Z'))
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(100_000)
  try {
    const drafts = createDrafts(), session = SessionId('clock-check')
    const draft = drafts.save(session, { kind: 'expert', data: expert })
    wall.mockReturnValue(Date.parse('2026-10-27T08:00:00Z') + (direction === 'forward' ? 9 : -9) * 60 * 60 * 1000)
    elapsed.mockReturnValue(100_000 + (direction === 'forward' ? 60_000 : 15 * 60 * 1000))
    expect(drafts.confirm(session, draft.id)).toBe(direction === 'forward')
    expect(drafts.claim(session, draft.id)?.data.name).toBe(direction === 'forward' ? expert.name : undefined)
  } finally { wall.mockRestore(); elapsed.mockRestore() }
})
it('matches Chinese, English, full and shortened slugs without choosing ambiguous members', () => {
  const experts = [member('engineering-reviewer', '代码审查员', 'Code Reviewer'), member('testing-reviewer', '测试审查员', 'Test Reviewer')]
  expect(matchMember(experts, 'CODE REVIEWER')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, '代码审查员')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, 'engineering-reviewer')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, 'reviewer')).toEqual({ kind: 'ambiguous', candidates: experts })
  expect(matchMember(experts, 'unknown')).toEqual({ kind: 'missing', candidates: [] })
  expect(matchMember([{ ...experts[0], conflict: true }], '代码审查员').kind).toBe('missing')
})
it('isolates drafts by session and kind; a replacement invalidates an outstanding confirmation', () => {
  const drafts = createDrafts()
  const a = SessionId('a'), b = SessionId('b')
  const first = drafts.save(a, { kind: 'expert', data: expert })
  expect(drafts.get(b, first.id)).toBeUndefined()
  expect(drafts.claim(a, first.id)).toBeUndefined()
  const latest = drafts.save(a, { kind: 'expert', data: { ...expert, name: '新专家' } })
  expect(drafts.confirm(a, first.id)).toBe(false)
  expect(drafts.confirm(a, latest.id)).toBe(true)
  expect(drafts.claim(b, latest.id)).toBeUndefined()
  expect(drafts.claim(a, latest.id)?.data.name).toBe('新专家')
  expect(drafts.claim(a, latest.id)).toBeUndefined()
})
it('expires at the deadline and copies drafts on entry and retrieval', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  try {
    const drafts = createDrafts(), session = SessionId('a')
    const data = { ...expert }, draft = drafts.save(session, { kind: 'expert', data })
    data.name = 'mutated'
    expect(drafts.get(session, draft.id)?.data.name).toBe(expert.name)
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(drafts.confirm(session, draft.id)).toBe(false)
    expect(drafts.claim(session, draft.id)).toBeUndefined()
  } finally { vi.useRealTimers() }
})
it.each(['zh', 'en'] as const)('records the full expert draft and save instructions in %s', (locale) => {
  expect(renderDraft({ kind: 'expert', data: expert }, locale, [])).toMatchSnapshot()
})

it('bounds pending sessions and releases capacity when drafts expire', () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  try {
    const drafts = createDrafts(() => 'zh')
    for (let index = 0; index < 100; index++) drafts.save(SessionId(String(index)), { kind: 'expert', data: expert })
    expect(() => drafts.save(SessionId('overflow'), { kind: 'expert', data: expert })).toThrow('待处理草案过多')
    vi.advanceTimersByTime(15 * 60 * 1000)
    expect(drafts.save(SessionId('overflow'), { kind: 'expert', data: expert }).draft.data.name).toBe(expert.name)
  } finally { vi.useRealTimers() }
})
