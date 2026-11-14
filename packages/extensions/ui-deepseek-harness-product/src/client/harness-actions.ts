/** File-library selection enters the upstream composer through its attachment admission API. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationController } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { LIBRARY_ATTACHMENT_LIMITS, type LibraryEntry } from '@deepseek-harness/product/library'
import { invokeLibraryRequest, readLibraryFile } from './library-data.ts'
/** Prepare ordinary files for the original upload, retry, card and Session persistence implementation.
 * @param ctx Native client services.
 * @returns An attachment action that admits the complete selection or leaves the current draft unchanged.
 */
export function createHarnessActions(ctx: Context): {
  attachLibraryFiles(sessionId: SessionId, entries: readonly LibraryEntry[], signal: AbortSignal): Promise<void>
} {
  return {
    async attachLibraryFiles(sessionId: SessionId, entries: readonly LibraryEntry[], signal: AbortSignal): Promise<void> {
      if (entries.length < 1 || entries.length > LIBRARY_ATTACHMENT_LIMITS.files
        || entries.reduce((total, entry) => total + entry.sizeBytes, 0) > LIBRARY_ATTACHMENT_LIMITS.bytes) throw new Error('Invalid attachment selection')
      const files: File[] = []
      for (const entry of entries) {
        const value = await readLibraryFile(invokeLibraryRequest,
          { libraryId: entry.libraryId, entryId: entry.id, attachment: true, ...(entry.sha256 ? { sha256: entry.sha256 } : {}) }, signal)
        signal.throwIfAborted()
        files.push(new File([value.data], entry.name, { type: value.mediaType ?? 'application/octet-stream' }))
      }
      await ctx.sessions.using(sessionId, { source: 'gateway', signal }, (reference) => {
        signal.throwIfAborted()
        const conversation = ctx.conversation
        if (!(conversation instanceof ConversationController)) throw new Error('Native attachment admission unavailable')
        const drafts = conversation.createDrafts(sessionId, files, reference.binding.session.getSnapshot().subagent === null)
        try {
          if (!conversation.input.for(reference.binding.ctx).addAttachments(drafts.map(value => value.id))) {
            throw new Error('The composer is busy; try again')
          }
        } catch (error) {
          conversation.releaseDraftAttachments(drafts)
          throw error
        }
        return Promise.resolve()
      })
    },
  }
}
