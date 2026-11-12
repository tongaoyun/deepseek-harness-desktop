/** HTTP acknowledgement used by personal connector fixtures. */
import { z } from 'zod'

/** Return the server's immutable release identity after a fixture accepts a save.
 * @param input Captured POST request.
 * @param employeeId Authenticated fixture employee.
 * @returns Successful connector release acknowledgement.
 */
export function savedConnectorResponse(input: RequestInit | undefined, employeeId: string): Response {
  if (typeof input?.body !== 'string') throw new Error('Expected a connector POST body')
  const value = z.looseObject({ id: z.string(), version: z.string() }).parse(JSON.parse(input.body))
  return Response.json({ success: true, data: { ...value, kind: 'connector', status: 'DRAFT', creatorEmployeeId: employeeId } })
}
