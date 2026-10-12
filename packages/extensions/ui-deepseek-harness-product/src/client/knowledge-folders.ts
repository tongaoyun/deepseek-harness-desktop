/** Resolve product folder metadata without using display names as engine paths. */
import type { KnowledgeFolder } from './knowledge-data.ts'

/** Resolve a root-to-leaf path and reject incomplete or cyclic hierarchies.
 * @param folders Complete authorized library folder listing.
 * @param id Selected folder, or the root.
 * @returns Ancestors followed by the selected folder.
 */
export function knowledgeFolderTrail(folders: readonly KnowledgeFolder[], id: string | null | undefined): readonly KnowledgeFolder[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]))
  const trail: KnowledgeFolder[] = []
  const visited = new Set<string>()
  let current = id
  while (current != null) {
    const folder = byId.get(current)
    if (!folder || visited.has(current)) throw new Error('Invalid knowledge folder hierarchy')
    visited.add(current); trail.unshift(folder); current = folder.parentId
  }
  return trail
}
