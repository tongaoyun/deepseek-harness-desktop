import { z } from 'zod'

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(value => Array.from(value).length <= max)
/** UUID-based identifiers accepted for editable personal teams. */
export const TEAM_CUSTOM_ID =
  /^team-custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
/** Member identity, duty, and instructions in an editable team. */
export const teamMemberSchema = z
  .object({ expertSlug: text(128), duty: text(100), instructions: text(2000),
    expertVersion: z.string().min(1).max(80).optional(), expertSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() })
  .strict()
/** Validated personal-team settings, including unique members and coordinator selection. */
export const teamInputSchema = z
  .object({
    id: z
      .string()
      .regex(TEAM_CUSTOM_ID)
      .optional(),
    name: text(40).refine(value => !/[@\u0000-\u001f]/u.test(value)),
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
        items =>
          new Set(items.map(item => item.expertSlug)).size === items.length,
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
      .refine(value => Array.from(value).length <= 12000),
  })
  .strict()
  .refine(
    value =>
      value.coordinatorMode !== 'custom' ||
      value.coordinatorPrompt.trim().length > 0,
  )
/** Editable personal-team settings. */
export type TeamInput = z.infer<typeof teamInputSchema>
/** Saved team with an identity and optional company ownership marker. */
export type ExpertTeam = TeamInput & { id: string; company?: boolean }
/** Saved personal team with its required identifier. */
export const teamSchema = teamInputSchema.and(
  z.object({ id: z.string().regex(TEAM_CUSTOM_ID) }),
)

/** Snapshot transport allows shared teams; editable input remains personal-only. */
export const sharedTeamSchema = teamInputSchema.safeExtend({
  id: z.string().regex(/^team-shared-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  company: z.literal(true),
})
/** A published team references immutable expert packages instead of embedding personas. */
export const publishedTeamSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80),
  team: teamInputSchema.safeExtend({
    id: z.never().optional(),
    members: z.array(teamMemberSchema.required({ expertVersion: true, expertSha256: true }).refine(member => member.expertVersion === '0.0.0-' + member.expertSha256.slice(0, 56))).min(2).max(8)
      .refine(items => new Set(items.map(item => item.expertSlug)).size === items.length),
  }),
}).strict()
/** Company team definition and exact member references. */
export type PublishedTeam = z.infer<typeof publishedTeamSchema>
/** Parse a bounded team definition.
 * @param text - UTF-8 team JSON.
 * @returns Team rules and immutable member references.
 */
export function publishedTeamDocument(text: string): PublishedTeam {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('专家团发布文件最多 2 MiB')
  return publishedTeamSchema.parse(JSON.parse(text))
}
