/** Snapshot an explicitly selected native deliverable through the Session filesystem. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { isPresentedData, isPresentedFile, basename } from '@deepseek-ai/dsh-client-ui-deliverables/src/presented.ts'
/** Resolve trusted event coordinates, never a renderer-supplied local path.
 * @param ctx Native Session query and read authority.
 * @param input Exact presented event and file index with main-owned byte cap.
 * @param signal Employee and request lifetime.
 * @returns Bounded immutable bytes for an explicit save-to-library operation.
 */
export async function readLibraryArchive(
  ctx: Context,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<{ name: string; dataBase64: string }> {
  const value = z
    .object({
      sessionId: z.string().min(1).max(180),
      seq: z.number().int().nonnegative(),
      index: z.number().int().nonnegative(),
      maxBytes: z
        .number()
        .int()
        .positive()
        .max(512 * 1024 * 1024),
    })
    .strict()
    .parse(input)
  const sessionId = brandString<SessionId>(value.sessionId),
    seq = value.seq as SessionSeq
  const { target, session } = await ctx.sessionQuery.readEvent({ sessionId, seq, before: 0, after: 0 }, signal)
  const file =
    target.type === 'deliverables/presented' && isPresentedData(target.data)
      ? target.data.files[value.index]
      : undefined
  if (!isPresentedFile(file)) throw new Error('The selected native result is unavailable')
  const scope = { sessionId, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot }
  const before = await ctx.workspaceFiles.stat(scope, file.path, signal)
  if (before.bytes === undefined || before.bytes < 1 || before.bytes > value.maxBytes)
    throw new Error('The selected file exceeds the upload policy')
  const data = new Uint8Array(before.bytes)
  for (let offset = 0; offset < data.byteLength; ) {
    const result = await ctx.workspaceFiles.readBytes(
      scope,
      file.path,
      { range: { offset, length: Math.min(256 * 1024, data.byteLength - offset) } },
      signal,
    )
    signal.throwIfAborted()
    if (
      result.version !== before.version ||
      result.bytes !== before.bytes ||
      result.offset !== offset ||
      result.data.byteLength < 1 ||
      offset + result.data.byteLength > data.byteLength
    )
      throw new Error('The result changed; save it again')
    data.set(result.data, offset)
    offset += result.data.byteLength
  }
  const after = await ctx.workspaceFiles.stat(scope, file.path, signal)
  if (after.version !== before.version || after.bytes !== before.bytes)
    throw new Error('The result changed; save it again')
  signal.throwIfAborted()
  return { name: basename(file.path), dataBase64: Buffer.from(data).toString('base64') }
}
