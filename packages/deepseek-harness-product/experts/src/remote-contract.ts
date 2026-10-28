import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec, TypertRemoteMethodSpec } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { TYPERT_REMOTE as generated } from './generated/typert.remote-client.js'
import { creationDraftSchema } from './creation-contract.ts'
import { teamInputSchema, teamSnapshotSchema } from './team-contract.ts'
import { CUSTOM_EXPERT_SLUG, catalogSnapshotSchema, customExpertInputSchema, expertEditSchema } from './expert-contract.ts'

const enabledArraySchema = z.array(z.string())
const revisionSchema = z.number().int().min(0)
const enabledStateSchema = z.object({ enabled: enabledArraySchema, revision: revisionSchema })
const customSlugSchema = z.string().regex(CUSTOM_EXPERT_SLUG)
const teamIdSchema = z.string().min(1).max(128)

/** Confirmed editor data is validated on both sides of the Remote. */
export const creationEditorSchema = z.object({ draft: creationDraftSchema, catalog: catalogSnapshotSchema, teams: teamSnapshotSchema })
/** Current editing inputs delivered with a single confirmed draft claim. */
export type CreationEditorData = z.infer<typeof creationEditorSchema>

type Methods = typeof generated.methods
type ValidationRule = { parameters: Readonly<Partial<Record<string, z.ZodType>>>; result: z.ZodType }
type ValidationRules = {
  [Endpoint in keyof Methods]: {
    parameters: { [Name in keyof Parameters<Methods[Endpoint]['invoke']>[1]]: z.ZodType }
    result: z.ZodType
  }
}

// Product semantics complement compiler-owned wire facts: TS cannot describe bounds,
// UUIDs, defaults, transformations or exact-object checks. Missing/new parameters fail closed.
const validationRules = {
  'agencyAgents/claimCreation': { parameters: { sessionId: z.string().min(1).max(128), proposalId: z.uuid() }, result: creationEditorSchema },
  'agencyAgents/getTeams': { parameters: {}, result: teamSnapshotSchema },
  'agencyAgents/saveTeam': { parameters: { team: teamInputSchema, enabled: z.boolean(), expectedRevision: revisionSchema }, result: teamSnapshotSchema },
  'agencyAgents/setTeamEnabled': { parameters: { id: teamIdSchema, enabled: z.boolean(), expectedRevision: revisionSchema }, result: teamSnapshotSchema },
  'agencyAgents/deleteTeam': { parameters: { id: teamIdSchema, expectedRevision: revisionSchema }, result: teamSnapshotSchema },
  'agencyAgents/exportTeam': { parameters: { id: teamIdSchema, expectedRevision: revisionSchema }, result: z.object({ resourceKey: z.string(), files: z.record(z.string(), z.string()) }).strict() },
  'agencyAgents/getCatalog': { parameters: { refreshCompany: z.boolean() }, result: catalogSnapshotSchema },
  'agencyAgents/saveCustomExpert': { parameters: { expert: customExpertInputSchema, enabled: z.boolean(), expectedRevision: revisionSchema }, result: catalogSnapshotSchema },
  'agencyAgents/deleteCustomExpert': { parameters: { slug: customSlugSchema, expectedRevision: revisionSchema }, result: catalogSnapshotSchema },
  'agencyAgents/getCustomExpert': { parameters: { slug: customSlugSchema }, result: expertEditSchema },
  'agencyAgents/getEnabled': { parameters: {}, result: enabledStateSchema },
  'agencyAgents/setEnabled': { parameters: { enabled: enabledArraySchema, expectedRevision: revisionSchema }, result: enabledStateSchema },
  'agencyAgents/getPrompt': { parameters: { slug: z.string().min(1).max(128), division: z.string().min(1).max(64) }, result: z.object({ prompt: z.string() }) },
} satisfies ValidationRules

function semanticCodec(original: Pick<TypertRemoteCodecSpec, 'typeSymbol' | 'description'>, schema: z.ZodType): TypertRemoteCodecSpec {
  return {
    mode: 'strict', typeSymbol: original.typeSymbol, description: original.description,
    create: () => schema,
    // Inferred JSON Schema would omit product refinements and incorrectly advertise weaker inputs.
    jsonSchemaError: 'Product semantic validation has no lossless JSON Schema projection',
  }
}

const rules: Readonly<Record<string, ValidationRule | undefined>> = validationRules
const methods = Object.fromEntries(Object.entries(generated.methods).map(([endpoint, descriptor]) => {
  const rule = rules[endpoint]
  if (!rule || Object.keys(rule.parameters).length !== descriptor.parameters.length) throw new Error(`Missing expert Remote validation: ${endpoint}`)
  const parameters = descriptor.parameters.map((parameter) => {
    const schema = rule.parameters[parameter.name]
    if (parameter.source !== 'json' || parameter.codec.mode !== 'strict' || !schema) throw new Error(`Unsupported expert Remote parameter: ${endpoint}/${parameter.name}`)
    const codec = semanticCodec(parameter.codec, schema)
    return { ...parameter, codec, strictCodec: codec }
  })
  return [endpoint, { ...descriptor, parameters, result: semanticCodec(descriptor.result, rule.result) } satisfies TypertRemoteMethodSpec]
}))

/** Native Remote methods with the product's existing strict semantic parsers. */
// Method facts and argument order are copied exclusively from the generated index;
// the assertion retains its endpoint-specific type correlation after Object.entries.
export const TYPERT_REMOTE = createTypertRemoteInfo({ package: generated.package, methods }, z) as typeof generated
/** Shared Host/Client descriptors backed by the same native method instances. */
export const AGENCY_AGENTS_DESCRIPTORS = TYPERT_REMOTE.descriptors
