/** Resolve the selected path independently of visible directory pages. */
import { useEffect, useState } from 'react'
import { knowledgeFolder, useKnowledgeRequests, type KnowledgeFolder } from './knowledge-data.ts'

/** Read each ancestor by identity; cancelled or failed paths never become a root selection.
 * @param knowledgeBaseId Authorized library identity.
 * @param folderId Selected folder, or root.
 * @param revision Explicit directory refresh identity.
 * @returns A complete path, loading state, or the read failure.
 */
export function useKnowledgeFolderLocation(knowledgeBaseId: string, folderId: string | null | undefined, revision = ''): {
  readonly trail: readonly KnowledgeFolder[] | undefined
  readonly loading: boolean
  readonly failure: unknown
} {
  const request = useKnowledgeRequests()
  const key = JSON.stringify([knowledgeBaseId, folderId ?? null, revision])
  const [result, setResult] = useState<{ key: string; trail?: readonly KnowledgeFolder[]; failure?: unknown }>()
  useEffect(() => {
    const controller = new AbortController()
    if (folderId == null) return () => { controller.abort() }
    const read = async () => {
      const trail: KnowledgeFolder[] = []
      const visited = new Set<string>()
      let id: string | null = folderId
      while (id !== null) {
        controller.signal.throwIfAborted()
        if (visited.has(id)) throw new Error('Invalid knowledge folder hierarchy')
        visited.add(id)
        const folder = knowledgeFolder(await request('knowledge.folders.get', { knowledgeBaseId, folderId: id }, controller.signal))
        if (folder.id !== id) throw new Error('Invalid knowledge folder identity')
        trail.unshift(folder); id = folder.parentId
      }
      if (!controller.signal.aborted) setResult({ key, trail })
    }
    void read().catch((failure: unknown) => { if (!controller.signal.aborted) setResult({ key, failure }) })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, folderId, key])
  const current = result?.key === key ? result : undefined
  return { trail: folderId == null ? [] : current?.trail,
    loading: folderId != null && current === undefined, failure: current?.failure }
}
