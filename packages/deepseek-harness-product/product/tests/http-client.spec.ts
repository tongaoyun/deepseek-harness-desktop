import { expect, it } from 'vitest'
import { DeepSeekHarnessApiClient } from '../src/http-client.ts'

const resources = [{ kind: 'knowledge-base', id: 'base' }]
const dependencyChecks = [{ kind: 'KNOWLEDGE_BASE', reference: 'orders', status: 'MISSING' }]

it('accepts the nullable error fields of a successful COLA response', async () => {
  const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async () => Response.json({ success: true, errCode: null, errMessage: null, data: { ready: true } }) })
  try { await expect(client.request('/api/test')).resolves.toEqual({ ready: true }) }
  finally { client.close() }
})

it.each(['json', 'file'] as const)('preserves server retry policy and dependency diagnostics for %s requests', async (transport) => {
  for (const [status, retryable] of [[503, false], [400, true], [429, false]] as const) {
    const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
      fetch: async () => Response.json({ success: false, errCode: 'CONFIGURATION_REQUIRED', errMessage: 'Check configuration',
        data: { retryable, resources, dependencyChecks } }, { status }) })
    try {
      const request = transport === 'json' ? client.request('/api/test') : client.requestBytes('/api/test', 4096)
      await expect(request).rejects.toMatchObject({ status, publicFailure: {
        code: 'CONFIGURATION_REQUIRED', message: 'Check configuration', retryable, resources, dependencyChecks,
      } })
    } finally { client.close() }
  }
})

it.each(['null', '[]', 'true', '{}', '{"success":"true","data":{}}', '{"success":true,"errCode":42}', '<html>proxy error</html>'])(
  'rejects malformed service envelopes with a stable diagnostic: %s', async (body) => {
    const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
      fetch: async () => new Response(body) })
    try {
      await expect(client.request('/api/test')).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE', status: 502 })
    } finally { client.close() }
  },
)

it('keeps HTTP status diagnostics when a gateway provides no structured failure details', async () => {
  const client = new DeepSeekHarnessApiClient({ baseUrl: 'https://product.test', getSessionToken: () => undefined,
    fetch: async () => Response.json({ success: false }, { status: 429 }) })
  try {
    await expect(client.request('/api/test')).rejects.toMatchObject({ code: 'SERVER_ERROR', status: 429, retryable: true })
  } finally { client.close() }
})
