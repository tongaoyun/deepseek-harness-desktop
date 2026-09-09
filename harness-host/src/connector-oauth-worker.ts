import { createInterface } from 'node:readline'
import { connectorOAuth, AuthorizationRequired, type OAuthRequest } from './connector-oauth.js'

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
const iterator = lines[Symbol.asyncIterator]()
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
const controller = new AbortController()
lines.on('close', () => controller.abort())
const deadline = setTimeout(() => process.exit(1), 200000)
try {
  const first = await iterator.next()
  if (first.done) throw new Error('Missing request')
  const request = JSON.parse(first.value) as OAuthRequest
  const result = await connectorOAuth(request, {
    signal: controller.signal,
    open: async (url) => { emit({ type: 'open', url }) },
    save: async (state) => {
      emit({ type: 'save', state })
      const ack = await iterator.next()
      if (ack.done || JSON.parse(ack.value).ok !== true) throw new Error('无法保存连接器授权')
    },
  })
  emit({ type: 'done', ...result })
} catch (error) {
  // Provider errors may embed credentials. Only controlled messages cross IPC.
  emit({ type: 'error', status: error instanceof AuthorizationRequired ? 401 : 503,
    error: error instanceof AuthorizationRequired ? '连接器需要重新授权' : '授权未完成，请检查服务的 OAuth 配置、网络或重试' })
} finally {
  clearTimeout(deadline)
  lines.close()
}
process.exit(0)
