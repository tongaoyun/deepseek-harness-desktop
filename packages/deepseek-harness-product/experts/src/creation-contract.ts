/** Session-owned, expiring creation drafts; only explicit confirmation permits one editor claim. */
import { z } from 'zod'
import { customExpertInputSchema, type ExpertSummary } from './expert-contract.ts'
import { effectiveCoordinator, teamInputSchema } from './team-contract.ts'

/** Drafts always create personal content; existing identities cannot be overwritten. */
export const creationDraftSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('expert'), data: customExpertInputSchema.omit({ slug: true }).strict() }),
  z.object({ kind: z.literal('team'), data: teamInputSchema.safeExtend({ id: z.never().optional() }) }),
])
/** Complete validated personal-content preview. */
export type CreationDraft = z.infer<typeof creationDraftSchema>

/** Match a member name or slug only when one available candidate remains.
 * @param experts - Current catalog, including conflict flags.
 * @param query - Chinese/English name or full/short slug.
 * @returns Unique slug, or candidates requiring clarification.
 */
export function matchMember(experts: readonly ExpertSummary[], query: string):
  { kind: 'match'; slug: string } | { kind: 'missing' | 'ambiguous'; candidates: ExpertSummary[] } {
  const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase()
  const q = normalize(query)
  const available = experts.filter(expert => !expert.conflict && !expert.teamMember)
  const exact = available.filter(expert => normalize(expert.slug) === q)
  const names = exact.length ? exact : available.filter(expert => [expert.name, expert.nameEn].some(name => normalize(name) === q))
  const matches = names.length ? names : q === '' ? [] : available.filter(expert =>
    [expert.name, expert.nameEn, expert.slug.replace(/^[^-]+-/u, '')].some(name => normalize(name).includes(q)))
  return matches.length === 1 ? { kind: 'match', slug: matches[0].slug }
    : { kind: matches.length ? 'ambiguous' : 'missing', candidates: matches }
}

/** Render complete, replayable draft text without executable links or delimiter-sensitive fences.
 * @param draft - Validated draft.
 * @param locale - Interface language.
 * @param experts - Catalog used to show member names.
 * @returns Markdown preview with the final-save requirement.
 */
export function renderDraft(draft: z.input<typeof creationDraftSchema>, locale: 'zh' | 'en', experts: readonly ExpertSummary[]): string {
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en
  const data = draft.data
  const lines = [`### ${text('草案', 'Draft')}: ${data.name}`, data.description]
  if (draft.kind === 'expert') lines.push(`**${text('分类', 'Category')}**: ${draft.data.division}`, '', ...draft.data.prompt.split('\n').map(line => `> ${line}`))
  else {
    const team = draft.data
    lines.push(`**${text('目标', 'Goal')}**: ${team.goal}`, `**${text('约束', 'Constraints')}**: ${team.constraints}`, `**${text('交付要求', 'Deliverables')}**: ${team.deliveryRequirements}`)
    for (const member of team.members) {
      const expert = experts.find(candidate => candidate.slug === member.expertSlug)
      lines.push(`- ${locale === 'en' ? expert?.nameEn ?? member.expertSlug : expert?.name ?? member.expertSlug}: ${member.duty}\n  ${member.instructions}`)
    }
    lines.push(`**${text('标签', 'Tags')}**: ${team.tags.join(', ')}`, ...team.examples.map(example => `- ${example}`),
      `**${text('主理人规则', 'Coordinator rules')}**`, ...effectiveCoordinator(team, locale).split('\n').map(line => `> ${line}`))
  }
  lines.push('', text('请核对草案，可以继续在对话中修改。确认后打开编辑器，点击保存才会加入「我的」；提交公司审核仍需单独操作。', 'Review this draft or request changes in chat. After confirmation, open the editor and click Save to add it to Mine. Company review is a separate action.'))
  return lines.join('\n')
}
