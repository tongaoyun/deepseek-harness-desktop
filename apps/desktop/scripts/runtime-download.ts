/** Retry immutable runtime downloads that are verified before packaging. */

export interface RuntimeDownloadRetryOptions {
  readonly attempts?: number
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly warn?: (message: string) => void
}

const DEFAULT_ATTEMPTS = 3
const RETRY_DELAY_MS = 2_000

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** Retry transient transport failures without accepting an incomplete artifact. */
export async function retryRuntimeDownload<T>(
  operation: () => Promise<T>,
  options: RuntimeDownloadRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('desktop runtime download: attempts must be a positive integer')
  }
  const wait = options.wait ?? defaultWait
  const warn = options.warn ?? (message => console.warn(message))
  let failure: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      failure = error
      if (attempt === attempts) throw error
      warn(`desktop runtime download: attempt ${attempt} failed; retrying`)
      await wait(RETRY_DELAY_MS * attempt)
    }
  }
  throw failure
}
