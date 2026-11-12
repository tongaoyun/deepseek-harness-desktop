/** Main-owned personal connector forms. Private values are write-only. */
import { z } from 'zod'
export { parseConnectorAuthorization, parseConnectorAuthorizationLaunch } from './connector-authorization.ts'
const id = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/)
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
const headers = z.record(z.string().min(1).max(200), z.string().max(4000)).superRefine((values, context) => {
  const names = Object.keys(values).map(name => name.toLowerCase())
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', message: 'HTTP header names must be unique regardless of case' })
  try { new Headers(values) }
  catch { context.addIssue({ code: 'custom', message: 'Enter valid HTTP header names and values' }) }
})
const environment = z.record(z.string().min(1).max(200).regex(/^[^=\0]+$/u), z.string().max(4000).refine(value => !value.includes('\0')))
const processArgument = z.string().max(2000).refine(value => !value.includes('\0'), 'Process arguments cannot contain NUL')
/** Public and write-only private fields accepted by personal connector editing. */
export const ConnectorDraftFields = z.object({ kind: z.literal('connector'), id, version,
  name: z.string().trim().min(1).max(80), summary: z.string().trim().min(1).max(300),
  author: z.string().trim().max(80).optional(), category: z.string().min(1).max(80),
  transport: z.enum(['streamable-http', 'stdio']).optional(), url: z.string().max(2000).optional(),
  oauthProviderId: id.optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  command: processArgument.optional(), arguments: z.array(processArgument).max(100).default([]),
  headers: headers.default({}),
  environment: environment.default({}),
}).strict()
/** Validate connection targets and configured OAuth boundaries. */
export const ConnectorDraftSchema = ConnectorDraftFields.superRefine((draft, context) => {
  if (draft.oauthProviderId && (draft.transport !== 'streamable-http' || Object.keys(draft.headers).length || Object.keys(draft.environment).length)) {
    context.addIssue({ code: 'custom', path: ['oauthProviderId'], message: 'Configured OAuth providers cannot use local secrets or stdio' })
  }
  if (draft.transport === 'streamable-http' && !draft.oauthProviderId) {
    try {
      const endpoint = new URL(draft.url ?? '')
      // Query parameters are part of the connector identity. Keeping them out
      // of drafts makes the product and runtime URL contracts deterministic and
      // prevents a hidden per-request credential or routing flag.
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) throw new Error('Invalid endpoint')
    } catch { context.addIssue({ code: 'custom', path: ['url'], message: 'An HTTP MCP endpoint without embedded credentials is required' }) }
  } else if (draft.transport !== 'streamable-http' && (draft.transport !== 'stdio' || !draft.command?.trim())) {
    context.addIssue({ code: 'custom', path: ['command'], message: 'Select a transport and executable' })
  }
})
/** Validated personal connector draft; private values remain in the main process. */
export type ConnectorDraft = z.infer<typeof ConnectorDraftSchema>

/** Compare connection targets independently of metadata and private values.
 * @param left Current connection transport, endpoint, executable and arguments.
 * @param right Saved target whose private values may be retained.
 * @returns Whether both targets match, treating empty optional fields as absent and comparing arguments exactly.
 */
export function connectorTargetMatches(left: Pick<ConnectorDraft, 'transport' | 'url' | 'command' | 'arguments'>,
  right: Pick<ConnectorDraft, 'transport' | 'url' | 'command' | 'arguments'>): boolean {
  return left.transport === right.transport && (left.url || undefined) === (right.url || undefined)
    && (left.command || undefined) === (right.command || undefined) && left.arguments.length === right.arguments.length
    && left.arguments.every((value, index) => value === right.arguments[index])
}

/** Validate the receipt for a server-owned immutable extension version. */
export const ConnectorSaveResultSchema = z.object({
  kind: z.literal('connector'), id, version,
  visibility: z.literal('PERSONAL'),
})
/** Result of saving a server-owned immutable extension version. */
export type ConnectorSaveResult = Readonly<z.infer<typeof ConnectorSaveResultSchema>>

/** Validate masked editing fields returned by the desktop connector manager. */
export const ConnectorEditorSnapshotSchema = z.object({
  draft: ConnectorDraftSchema,
  configured: z.boolean(), savePending: z.boolean(),
})

const DeviceConfigurationFields = z.object({
  id, version, arguments: z.array(z.string()), headers: z.array(z.string().min(1)), environment: z.array(z.string().min(1)),
  configured: z.boolean(), timeoutSeconds: z.number().int().min(1).max(600),
})
/** Validate a connector's public connection template without returning private values. */
export const ConnectorDeviceConfigurationSchema = z.discriminatedUnion('transport', [
  DeviceConfigurationFields.extend({ transport: z.literal('stdio'), command: z.string().min(1), url: z.undefined().optional() }),
  DeviceConfigurationFields.extend({ transport: z.literal('streamable-http'), url: z.url({ protocol: /^https?$/ }), command: z.undefined().optional() }),
])
/** Public template and local configuration status for a fixed connector version. */
export type ConnectorDeviceConfigurationSnapshot = Readonly<z.infer<typeof ConnectorDeviceConfigurationSchema>>
/** Validate confirmation that the selected connector version was configured on this device. */
export const ConnectorConfigurationSaveResultSchema = z.object({ id, version, configured: z.literal(true) })

/** Validate the Host's explicit reconnect result without treating partial failure as success. */
export const ConnectorRefreshResultSchema = z.object({ connectedIds: z.array(z.string().min(1)),
  unavailableIds: z.array(z.string().min(1)) }).strict()

/** Confirm deletion of a server resource identified independently of its historical versions. */
export const ExtensionRemovalResultSchema = z.object({ id, removed: z.literal(true) })
/** Confirm submission of the requested immutable resource version for shared review. */
export const ExtensionSubmissionResultSchema = z.object({ id, version, submitted: z.literal(true) })
