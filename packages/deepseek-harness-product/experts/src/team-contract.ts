import { z } from 'zod'
import { teamText } from './team-i18n.ts'
import { TEAM_PROMPTS_EN } from './team-prompts-en.ts'
import { TEAM_PROMPTS } from './team-prompts.ts'
export { TEAM_PROMPTS }
import { teamSchema, sharedTeamSchema } from '@deepseek-harness/product/company-team'
export { TEAM_CUSTOM_ID, teamMemberSchema, teamInputSchema, teamSchema } from '@deepseek-harness/product/company-team'
export type { TeamInput, ExpertTeam } from '@deepseek-harness/product/company-team'
import type { TeamInput, ExpertTeam } from '@deepseek-harness/product/company-team'
export const teamEngineStatusSchema = z.object({
  state: z.enum(['unsupported', 'disabled', 'enabled']),
  mode: z.enum(['subagent', 'native']),
  reason: z.string(),
  recommendation: z.string(),
})
export type TeamEngineStatus = z.infer<typeof teamEngineStatusSchema>
export const executableTeamSchema = z.union([teamSchema, sharedTeamSchema]).transform((value): ExpertTeam => value)
export const teamSnapshotSchema = z.object({
  teams: z.array(executableTeamSchema),
  enabledTeams: z.array(z.string()),
  enabledExperts: z.array(z.string()),
  revision: z.number().int().min(0),
  engine: teamEngineStatusSchema.optional(),
  nativeMembers: z.record(z.string(), z.string()).optional(),
})
/** Validated team catalog and enabled membership at one revision. */
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>
export const effectiveCoordinator = (team: TeamInput, locale: 'zh' | 'en' = 'zh'): string =>
  team.coordinatorMode === 'custom'
    ? team.coordinatorPrompt
    : (locale === 'en' ? TEAM_PROMPTS_EN : TEAM_PROMPTS)[team.coordinatorTemplateId]

/** Prefer exact IDs; a name shared by multiple enabled teams must never pick an arbitrary team. */
export function resolveEnabledTeam(snapshot: TeamSnapshot, query: string, locale: 'zh' | 'en'): ExpertTeam {
  const teams = snapshot.teams.filter(team => snapshot.enabledTeams.includes(team.id))
  const exact = teams.find(team => team.id === query)
  if (exact) return exact
  const matches = teams.filter(team => team.name === query)
  if (matches.length > 1) throw new Error(teamText(locale, '存在同名专家团，请使用专家团标识重新选择。'))
  if (!matches[0]) throw new Error(teamText(locale, '专家团未启用或不存在。'))
  return matches[0]
}
