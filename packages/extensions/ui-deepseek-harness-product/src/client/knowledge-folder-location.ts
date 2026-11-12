/** Resolve the selected path independently of visible directory pages. */
import { useEffect, useState } from 'react'
import { knowledgeFolder, useKnowledgeRequests, type KnowledgeFolder } from './knowledge-data.ts'

/** Read each ancestor by identity; refresh retains the path until confirmed or rejected.
 * @param knowledgeBaseId Authorized library identity.
 * @param folderId Selected folder, or root.
 * @param revision Explicit directory refresh identity.
 * @param beforeCommit Capture current control focus before publishing a confirmed path or failure.
 * @returns A complete path, loading state, or the read failure.
 */
export function useKnowledgeFolderLocation(
  knowledgeBaseId: string, folderId: string | null | undefined, revision = '', beforeCommit?: () => void,
): {
  readonly trail: readonly KnowledgeFolder[] | undefined
  readonly loading: boolean
  readonly failure: unknown
} {
  const request = useKnowledgeRequests()
  const selection = JSON.stringify([knowledgeBaseId, folderId ?? null])
  const key = JSON.stringify([selection, revision])
  const [result, setResult] = useState<{ key: string; selection: string; trail?: readonly KnowledgeFolder[]; failure?: unknown }>()
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
      if (!controller.signal.aborted) { beforeCommit?.(); setResult({ key, selection, trail }) }
    }
    void read().catch((failure: unknown) => {
      if (!controller.signal.aborted) { beforeCommit?.(); setResult({ key, selection, failure }) }
    })
    return () => { controller.abort() }
  }, [request, knowledgeBaseId, folderId, key, selection, beforeCommit])
  const current = result?.key === key ? result : undefined
  return { trail: folderId == null ? [] : result?.selection === selection ? result.trail : undefined,
    loading: folderId != null && current === undefined,
    failure: folderId != null && result?.selection === selection ? result.failure : undefined }
}
