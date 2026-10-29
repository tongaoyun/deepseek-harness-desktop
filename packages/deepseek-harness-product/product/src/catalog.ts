/** Public catalog data shared by the main process and product pages. */
import { z } from 'zod'

const identity = z.string().refine(value => value.trim() !== '', 'A resource identity is required')
const optionalText = z.string().nullish().transform(value => value?.trim() ? value : undefined)
/** Wire-level tool metadata shared by Renderer catalogs and Runtime execution. */
export const ConnectorCatalogToolSchema = z.object({ name: identity, displayName: optionalText, description: optionalText,
  access: z.enum(['READ', 'WRITE']) }).transform(value => ({ ...value, displayName: value.displayName ?? value.name }))

/** Validate complete tool metadata without dropping unknown access policies or duplicate names. */
export const ConnectorCatalogToolsSchema = z.array(ConnectorCatalogToolSchema).default([]).superRefine((tools, context) => {
  const names = new Set<string>()
  for (const [index, entry] of tools.entries()) {
    if (names.has(entry.name)) context.addIssue({ code: 'custom', path: [index, 'name'], message: 'Duplicate connector tool name' })
    names.add(entry.name)
  }
})

const item = z.object({
  id: identity,
  name: optionalText, displayName: optionalText,
  description: optionalText, summary: optionalText,
  author: optionalText, category: optionalText, version: optionalText, sha256: optionalText,
  scope: optionalText, companyId: optionalText, ownerEmployeeId: optionalText,
  ownerDepartmentId: optionalText, ownerName: optionalText, referenceKey: optionalText, reference: optionalText,
  transport: optionalText, authMode: optionalText, authorizationStatus: optionalText,
  createdAt: optionalText, updatedAt: optionalText, visibility: optionalText, reviewStatus: optionalText,
  managed: z.boolean().optional(), canEdit: z.boolean().optional(), canSubmit: z.boolean().optional(),
  canDelete: z.boolean().optional(), canConfigure: z.boolean().optional(),
  canRead: z.boolean().optional(), canManage: z.boolean().optional(),
  tools: ConnectorCatalogToolsSchema,
}).transform(({ name, displayName, summary, description, ...value }, context) => {
  const label = displayName ?? name
  if (label === undefined) {
    context.addIssue({ code: 'custom', path: ['name'], message: 'A resource name is required' })
    return z.NEVER
  }
  return { ...value, label, description: description ?? summary }
})

/** Reject incomplete catalogs instead of presenting partial or invented resource identities. */
export const ProductCatalogSchema = z.array(item).superRefine((entries, context) => {
  const ids = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate catalog resource identity' })
    ids.add(entry.id)
  }
})

/** Public tool metadata; the tool name supplies an absent business display name. */
export type ProductConnectorTool = Readonly<z.output<typeof ConnectorCatalogToolSchema>>
/** Validated connector or knowledge-base display data with an explicit resource identity. */
export type ProductCatalogItem = Readonly<z.output<typeof item>>
