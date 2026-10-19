/** Browser-safe personal extension forms and previews, without archive or YAML parsing. */
import { z } from 'zod'

/** Stable skill and kit categories in product display order. */
export const EXTENSION_CATEGORIES = ['office-productivity', 'content-creation', 'marketing', 'ecommerce-retail',
  'finance', 'legal', 'recruiting', 'code-development', 'code-review', 'security-testing', 'database-analysis',
  'operations-deployment', 'developer-tools', 'design', 'product-management', 'knowledge-research', 'workflow',
  'agent-evolution', 'communication', 'other'] as const

const id = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/)
const fileId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
/** Project native discovery text to the server's bounded catalog summary.
 * @param description Complete native skill description.
 * @returns Whitespace-normalized summary of at most 300 UTF-16 units.
 */
export function skillCatalogSummary(description: string): string {
  const text = description.trim().replace(/\s+/g, ' ')
  if (text.length <= 300) return text
  const sentence = text.match(/^.*?[。．.!?！？](?=\s|$)/)?.[0]?.trim() ?? ''
  return sentence && sentence.length <= 300 ? sentence : `${text.slice(0, 299)}…`
}

const dependencies = {
  connectorRefs: z.array(id).max(128).default([]),
  requiredTools: z.array(z.string().regex(/^[a-z][a-z0-9_.-]+$/)).max(128).default([]),
  knowledgeBaseRefs: z.array(z.string().regex(/^(personal|department|company):[a-z][a-z0-9-]{2,63}$/)).max(32).default([]),
}
const skill = z.object({ id: fileId, name: z.string().trim().min(1).max(80), summary: z.string().trim().min(1).max(300),
  description: z.string().min(1).max(262_144).optional(),
  body: z.string().trim().min(1).max(262_144), triggers: z.array(z.string().min(2).max(120)).max(20).default([]),
  ...dependencies,
  importedId: fileId.optional(),
  source: z.object({ id, version, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
}).superRefine((value, context) => {
  if (value.description !== undefined && value.summary !== value.description && value.summary !== skillCatalogSummary(value.description)) {
    context.addIssue({ code: 'custom', path: ['summary'], message: 'Summary must match the native description or its catalog projection' })
  }
  if (new TextEncoder().encode(value.body).length > 262_144 || new TextEncoder().encode(value.description ?? '').length > 262_144) {
    context.addIssue({ code: 'custom', path: ['body'], message: 'Bundled skill exceeds 256 KiB' })
  }
})
const DraftFields = z.object({ kind: z.enum(['skill', 'expert-kit', 'connector']), id, version,
  name: z.string().trim().min(1).max(80), summary: z.string().trim().min(1).max(300),
  author: z.string().trim().max(80).optional(), category: z.string().min(1).max(80),
  triggers: z.array(z.string().min(2).max(120)).max(20).default([]),
  body: z.string().max(60_000).default(''), minimumDesktopVersion: version.default('0.1.0'), ...dependencies,
  skills: z.array(skill).max(128).default([]),
  transport: z.enum(['streamable-http', 'stdio']).optional(), url: z.string().max(2000).optional(),
  oauthProviderId: id.optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  command: z.string().max(2000).optional(), arguments: z.array(z.string().max(2000)).max(100).default([]),
  headers: z.record(z.string().min(1).max(200), z.string().max(4000)).default({}),
  environment: z.record(z.string().min(1).max(200), z.string().max(4000)).default({}),
  stageId: z.uuid().optional(),
}).strict()
/** Validate imported editable fields while allowing absent product metadata. */
export const ExtensionImportDraftSchema = DraftFields.partial()
/** Content editable by a creation conversation; connection secrets and staging are main-owned. */
export const ExtensionContentDraftSchema = DraftFields.omit({ transport: true, url: true, oauthProviderId: true,
  command: true, arguments: true, headers: true, environment: true, timeoutSeconds: true, stageId: true, author: true }).partial().strict()
/** Durable, employee-scoped conversation draft without paths or credentials. */
export const ExtensionAuthoringSnapshotSchema = z.object({
  authoringId: z.uuid(), sessionId: z.string().min(1).max(256), revision: z.number().int().nonnegative(),
  editing: z.boolean().optional(),
  pendingSave: z.object({ author: z.string().trim().max(80) }).strict().optional(),
  draft: ExtensionContentDraftSchema, saved: z.object({ id, version }).optional(),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() })),
  missingFields: z.array(z.string()),
}).strict()
/** Main-owned authoring state projected to UI and scoped model tools. */
export type ExtensionAuthoringSnapshot = z.infer<typeof ExtensionAuthoringSnapshotSchema>
/** Validate a complete save before generating files or opening a connection. */
export const ExtensionDraftSchema = DraftFields.superRefine((draft, context) => {
  if (draft.kind !== 'connector' && !EXTENSION_CATEGORIES.includes(draft.category as typeof EXTENSION_CATEGORIES[number])) {
    context.addIssue({ code: 'custom', path: ['category'], message: 'Select a supported category' })
  }
  if (draft.kind === 'skill' && (draft.body.trim() === '' || draft.triggers.length === 0)) {
    context.addIssue({ code: 'custom', path: ['body'], message: 'Skill body and trigger scenarios are required' })
  }
  if (draft.kind !== 'expert-kit' && draft.skills.length > 0) {
    context.addIssue({ code: 'custom', path: ['skills'], message: 'Bundled skills belong to expert kits' })
  }
  if (draft.kind === 'expert-kit' && (draft.skills.length === 0 || draft.body.trim() === '')) {
    context.addIssue({ code: 'custom', path: ['skills'], message: 'Kit guide and at least one valid skill are required' })
  }
  if (new Set(draft.skills.map(value => value.id)).size !== draft.skills.length) {
    context.addIssue({ code: 'custom', path: ['skills'], message: 'Bundled skill IDs must be unique' })
  }
  if (draft.kind === 'connector') {
    if (draft.oauthProviderId && (draft.transport !== 'streamable-http' || Object.keys(draft.headers).length || Object.keys(draft.environment).length)) {
      context.addIssue({ code: 'custom', path: ['oauthProviderId'], message: 'Configured OAuth providers cannot use local secrets or stdio' })
    }
    if (draft.transport === 'streamable-http' && !draft.oauthProviderId) {
      try {
        const endpoint = new URL(draft.url ?? '')
        if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Invalid endpoint')
      } catch { context.addIssue({ code: 'custom', path: ['url'], message: 'An HTTP MCP endpoint without embedded credentials is required' }) }
    } else if (draft.transport !== 'streamable-http' && (draft.transport !== 'stdio' || !draft.command?.trim())) {
      context.addIssue({ code: 'custom', path: ['command'], message: 'Select a transport and executable' })
    }
  }
})
/** Editable extension submitted to main. Secrets are accepted on writes, never returned by reads. */
export type ExtensionDraft = z.infer<typeof ExtensionDraftSchema>
/** Imported content without local paths or upload credentials. Missing fields remain editable. */
export interface ExtensionImportPreview {
  readonly stageId: string
  readonly draft: z.infer<typeof ExtensionImportDraftSchema>
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly missingFields: readonly string[]
}
/** Validate an import preview before displaying files or transferring its staging ownership. */
export const ExtensionImportPreviewSchema: z.ZodType<ExtensionImportPreview> = z.object({
  stageId: z.uuid(), draft: ExtensionImportDraftSchema,
  files: z.array(z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative() })),
  missingFields: z.array(z.string()),
}).superRefine((preview, context) => {
  if (preview.draft.kind === 'connector' || preview.draft.stageId !== undefined && preview.draft.stageId !== preview.stageId) {
    context.addIssue({ code: 'custom', path: ['draft'], message: 'Imported content does not match its staging' })
  }
})
/** Result of saving a server-owned immutable extension version. */
export interface ExtensionSaveResult {
  readonly kind: ExtensionDraft['kind']
  readonly id: string
  readonly version: string
  readonly visibility: 'PERSONAL'
  readonly installed: boolean
}
