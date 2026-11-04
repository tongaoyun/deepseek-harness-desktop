import { expect, it } from 'vitest'
import { matchMember } from './creation-contract.ts'
import type { ExpertSummary } from './expert-contract.ts'
const member = (slug: string, name: string, nameEn: string): ExpertSummary => ({ slug, name, nameEn, description: '', descriptionEn: '', emoji: '🧩', division: 'engineering', divisionZh: '工程', custom: false })

it('matches Chinese, English, full and shortened slugs without choosing ambiguous members', () => {
  const experts = [member('engineering-reviewer', '代码审查员', 'Code Reviewer'), member('testing-reviewer', '测试审查员', 'Test Reviewer')]
  expect(matchMember(experts, 'CODE REVIEWER')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, '代码审查员')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, 'engineering-reviewer')).toEqual({ kind: 'match', slug: 'engineering-reviewer' })
  expect(matchMember(experts, 'reviewer')).toEqual({ kind: 'ambiguous', candidates: experts })
  expect(matchMember(experts, 'unknown')).toEqual({ kind: 'missing', candidates: [] })
  expect(matchMember([{ ...experts[0], conflict: true }], '代码审查员').kind).toBe('missing')
})
