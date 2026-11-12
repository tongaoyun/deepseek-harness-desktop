/** Bounded, serialized local management diagnostics. */
import { appendFile, rename, rm, stat } from 'node:fs/promises'
import type { Log } from './types.ts'
import { logPath } from './core.ts'
const MAX_LOG_BYTES = 1 << 20
/** Create an instance-owned, serialized diagnostic writer.
 * @returns A logger keeping the current file and one bounded previous file.
 * Failures use console without rejecting business writes.
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
      } catch (error) {
        try { console.warn('技能管理日志写入失败', { event, detail, error: String(error) }) }
        catch (_error) { /* Diagnostics cannot reject a committed operation or block subsequent logging. */ }
      }
    })
    await queue
  }
}

