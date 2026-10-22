import { z } from 'zod'
import { TEAM_PROMPTS_EN } from './team-prompts-en.ts'
import { TEAM_PROMPTS } from './team-prompts.ts'
export { TEAM_PROMPTS }
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= max)
export const TEAM_CUSTOM_ID =
  /^team-custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
export const teamMemberSchema = z
  .object({ expertSlug: text(128), duty: text(100), instructions: text(2000) })
  .strict()
export const teamInputSchema = z
  .object({
    id: z
      .string()
      .regex(TEAM_CUSTOM_ID)
      .optional(),
    name: text(40).refine((value) => !/[@\r\n\u0000-\u001f]/u.test(value)),
    description: text(160),
    tags: z.array(text(16)).max(3),
    goal: text(2000),
    constraints: z.string().trim().max(2000),
    deliveryRequirements: text(2000),
    members: z
      .array(teamMemberSchema)
      .min(2)
      .max(8)
      .refine(
        (items) =>
          new Set(items.map((item) => item.expertSlug)).size === items.length,
      ),
    examples: z.array(text(1000)).min(1).max(3),
    coordinatorMode: z.enum(['template', 'custom']),
    coordinatorTemplateId: z.enum([
      'general',
      'product',
      'technical',
      'content',
      'data',
      'research',
    ]),
    coordinatorTemplateVersion: z.literal(1),
    coordinatorPrompt: z
      .string()
      .refine((value) => Array.from(value).length <= 12000),
  })
  .strict()
  .refine(
    (value) =>
      value.coordinatorMode !== 'custom' ||
      value.coordinatorPrompt.trim().length > 0,
  )
export type TeamInput = z.infer<typeof teamInputSchema>
export type ExpertTeam = TeamInput & { id: string }
export const teamSchema = teamInputSchema.and(
  z.object({ id: z.string().regex(TEAM_CUSTOM_ID) }),
)
export const teamEngineStatusSchema = z.object({
  state: z.enum(['unsupported', 'disabled', 'enabled']),
  mode: z.enum(['subagent', 'native']),
  reason: z.string(),
  recommendation: z.string(),
})
export type TeamEngineStatus = z.infer<typeof teamEngineStatusSchema>
export const teamSnapshotSchema = z.object({
  teams: z.array(teamSchema),
  enabledTeams: z.array(z.string()),
  enabledExperts: z.array(z.string()),
  revision: z.number().int().min(0),
  engine: teamEngineStatusSchema.optional(),
  nativeMembers: z.record(z.string(), z.string()).optional(),
})
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>
export const effectiveCoordinator = (team: TeamInput, locale: 'zh' | 'en' = 'zh'): string =>
  team.coordinatorMode === 'custom'
    ? team.coordinatorPrompt
    : (locale === 'en' ? TEAM_PROMPTS_EN : TEAM_PROMPTS)[team.coordinatorTemplateId]
