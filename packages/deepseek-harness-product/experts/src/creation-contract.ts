/** Resolve existing experts for AI-authored personal teams. */
import type { ExpertSummary } from './expert-contract.ts'

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
