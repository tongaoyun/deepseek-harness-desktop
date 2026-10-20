/** Browser-safe validation of employee-scoped connector authorization responses. */
import { z } from 'zod'

const Authorization = z.object({ connectorId: z.string().min(1), status: z.enum(['REQUIRED', 'PENDING', 'AUTHORIZED', 'EXPIRED']) })
const Launch = Authorization.extend({ status: z.literal('PENDING'),
  authorizationUrl: z.url({ protocol: /^https?$/ }),
})

/** Validate a status or revocation response for the requested connector.
 * @param value - Untrusted server or IPC response.
 * @param connectorId - Connector whose authorization was requested.
 * @returns Validated connector identity and authorization status.
 */
export function parseConnectorAuthorization(value: unknown, connectorId: string): z.infer<typeof Authorization> {
  const result = Authorization.parse(value)
  if (result.connectorId !== connectorId) throw new Error('Connector authorization response does not match the requested connector')
  return result
}

/** Validate an authorization launch before opening its URL or starting polling.
 * @param value - Untrusted server or IPC response.
 * @param connectorId - Connector whose authorization was requested.
 * @returns Validated pending launch and HTTP authorization URL.
 */
export function parseConnectorAuthorizationLaunch(value: unknown, connectorId: string): z.infer<typeof Launch> {
  const result = Launch.parse(value)
  if (result.connectorId !== connectorId) throw new Error('Connector authorization launch does not match the requested connector')
  return result
}
