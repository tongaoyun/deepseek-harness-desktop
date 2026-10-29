/** Exact byte reads for catalog documents and installable archives. */

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
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let complete = false
  const cancel = () => {
    void reader?.cancel(signal.reason).catch(() => {
      // A rejected cleanup cannot replace cancellation, overflow or a read failure.
    })
  }
  try {
    signal.throwIfAborted()
    if (Number(response.headers.get('content-length')) > limit) throw sizeError
    reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    signal.addEventListener('abort', cancel, { once: true })
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > limit) throw sizeError
      chunks.push(value)
    }
    complete = true
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (reader) {
      if (!complete) cancel()
      reader.releaseLock()
    } else { discardSkillResponse(response) }
  }
}
