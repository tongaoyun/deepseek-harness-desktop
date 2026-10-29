/** Bounded, serialized local management diagnostics. */
import { appendFile, rename, rm, stat } from 'node:fs/promises'
import type { Log } from './types.ts'
import { logPath } from './core.ts'
const MAX_LOG_BYTES = 1 << 20
/** Create an instance-owned, serialized diagnostic writer.
 * @returns A logger retaining the current file and one bounded previous file; failures do not reject business writes.
 */
export function makeLog(): Log {
  const file = logPath()
  let queue = Promise.resolve()
  return async (event, detail) => {
    queue = queue.then(async () => {
      try {
        const current = await stat(file).catch(() => null)
        if (current && current.size >= MAX_LOG_BYTES) {
          await rm(`${file}.1`, { force: true })
          await rename(file, `${file}.1`)
        }
        await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), event, detail })}\n`, 'utf8')
      } catch (_error) {
        /* 日志失败不阻塞主流程 */
      }
    })
    await queue
  }
}

