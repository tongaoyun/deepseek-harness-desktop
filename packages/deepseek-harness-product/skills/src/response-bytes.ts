/** Exact byte reads for catalog documents and installable archives. */
import { streamResponseBody } from '@deepseek-harness/product'

/** Release an unread response without making transport cleanup its caller's outcome.
 * @param response - Unlocked response whose body will not be consumed.
 */
export function discardSkillResponse(response: Response): void {
  void response.body?.cancel().catch(() => {
    // The request has already failed; cleanup must preserve that diagnostic.
  })
}

/** Read a complete response, rejecting oversized or cancelled content without returning partial bytes.
 * @param response - Response whose unlocked body is owned by this read.
 * @param limit - Maximum complete body size in bytes, including multibyte text.
 * @param signal - Request deadline; abort cancels an outstanding stream read.
 * @param sizeError - Owning operation's structured failure for a body exceeding the limit.
 * @returns Complete bytes; all exits release the reader and preserve the original read failure.
 */
export async function readSkillResponse(response: Response, limit: number, signal: AbortSignal, sizeError: Error): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  const length = await streamResponseBody(response, limit, signal, async (chunk) => { chunks.push(chunk) }, sizeError)
  return Buffer.concat(chunks, length)
}
