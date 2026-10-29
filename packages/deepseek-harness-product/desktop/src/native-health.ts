/** Wire validation shared by startup and employee device reports. */
import { z } from 'zod'
import { ProductError } from '@deepseek-harness/product/errors'

export const NATIVE_PROTOCOL = 'deepseek-harness.native.v1' as const

/** Sidecar operations consumed only by Electron main. */
export type NativeMethod = 'health' | 'device-identity.get'

/** Response envelope accepted from the product-owned sidecar. */
const nativeResponseSchema = z.object({
  protocol: z.literal(NATIVE_PROTOCOL),
  request_id: z.string().min(1).max(128),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(80).optional(),
    message: z.string().min(1).max(4096).optional(),
  }).strict().nullable().optional().refine(
    value => value === null || value === undefined || value.code !== undefined || value.message !== undefined,
    'native error must contain code or message',
  ),
}).strict().refine(value => value.result !== undefined || value.error !== undefined,
  'native response must contain result or error')

export type NativeResponse = z.infer<typeof nativeResponseSchema>

/** Parse an untrusted sidecar response before it can touch pending requests. */
export function nativeResponse(value: unknown): NativeResponse {
  const result = nativeResponseSchema.safeParse(value)
  if (!result.success) throw new Error('deepseek-harness-native returned an incompatible response protocol')
  return result.data
}

const healthSchema = z.object({
  ready: z.literal(true),
  protocol: z.literal(NATIVE_PROTOCOL),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)).max(32)
    .refine(values => values.includes('device-identity') && new Set(values).size === values.length),
})

/** Require a ready sidecar with the current protocol and device identity capability.
 * @param value - Untrusted health result from the sidecar process.
 * @returns Validated readiness and capabilities; invalid results reject startup and reporting.
 */
export function nativeHealth(value: unknown): z.infer<typeof healthSchema> {
  const result = healthSchema.safeParse(value)
  if (!result.success) throw new ProductError('DEVICE_HEALTH_INVALID', 'Native device capability is not ready or uses an incompatible protocol', true)
  return result.data
}
