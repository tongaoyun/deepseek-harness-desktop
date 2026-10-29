/** Bounded catalog downloads own one deadline through the complete response body. */
import { deadline } from '@deepseek-ai/dsh-timeout'
import { discardSkillResponse, readSkillResponse } from './response-bytes.ts'

/** Fetch catalog bytes and release the response on rejection, overflow or cancellation.
 * @param url Fixed catalog endpoint.
 * @param fetchImpl HTTP transport.
 * @param options Complete request bounds and operation-owned diagnostics.
 * @returns Complete response bytes.
 */
export async function readCatalogResponse(url: string | URL, fetchImpl: typeof fetch, options: {
  accept: string
  limit: number
  timeoutMs: number
  signal?: AbortSignal
  upstreamError: Error
  responseError: Error
}): Promise<Buffer> {
  const request = deadline(options.signal, options.timeoutMs, 'skills/catalog-timeout')
  const { signal } = request
  try {
    signal.throwIfAborted()
    let response: Response
    try { response = await fetchImpl(url, { headers: { accept: options.accept }, redirect: 'error', signal }) }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      throw options.upstreamError
    }
    if (!response.ok) {
      discardSkillResponse(response)
      throw options.upstreamError
    }
    try { return await readSkillResponse(response, options.limit, signal, options.responseError) }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason
      throw options.responseError
    }
  } finally { request[Symbol.dispose]() }
}
