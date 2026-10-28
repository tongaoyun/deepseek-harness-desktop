/** Session-owned, expiring creation drafts; confirmation permits one editor claim. */
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { z } from 'zod'
import { creationDraftSchema, type CreationDraft } from './creation-contract.ts'
/** Host service holding the current plugin instance's drafts. */
export const CREATION_SERVICE = 'agencyCreationDrafts'

/** Create one plugin-owned draft registry; unload discards all drafts.
 * @param locale - Current language for capacity errors.
 * @returns Session-isolated operations with a monotonic 15-minute confirmation lifetime and 100-Session bound.
 */
export function createDrafts(locale: () => 'zh' | 'en' = () => 'en') {
  const drafts = new Map<SessionId, { id: string; draft: CreationDraft; expires: number; confirmed: boolean }>()
  const cleanup = () => {
    for (const [session, entry] of drafts) if (entry.expires <= performance.now()) drafts.delete(session)
  }
  const get = (session: SessionId, id: string) => {
    cleanup()
    const entry = drafts.get(session)
    return entry?.id === id ? entry : undefined
  }
  return {
    save(session: SessionId, input: z.input<typeof creationDraftSchema>) {
      cleanup()
      if (!drafts.has(session) && drafts.size >= 100) {
        throw new Error(locale() === 'zh' ? '待处理草案过多，请先完成已有草案'
          : 'Too many pending creation sessions. Finish an existing draft first.')
      }
      const id = randomUUID(), draft = creationDraftSchema.parse(input)
      drafts.set(session, { id, draft, expires: performance.now() + 15 * 60 * 1000, confirmed: false })
      return { id, draft: structuredClone(draft) }
    },
    get(session: SessionId, id: string): CreationDraft | undefined {
      const entry = get(session, id)
      return entry && structuredClone(entry.draft)
    },
    confirm(session: SessionId, id: string): boolean {
      const entry = get(session, id)
      if (!entry || entry.confirmed) return false
      entry.confirmed = true
      return true
    },
    claim(session: SessionId, id: string): CreationDraft | undefined {
      const entry = get(session, id)
      if (!entry?.confirmed) return undefined
      drafts.delete(session)
      return structuredClone(entry.draft)
    },
  }
}
/** Operations owned by one Host plugin instance. */
export type CreationDrafts = ReturnType<typeof createDrafts>
