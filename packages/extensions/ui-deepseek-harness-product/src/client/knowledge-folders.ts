/** Resolve product folder metadata without using display names as engine paths. */
import type { KnowledgeFolder } from './knowledge-data.ts'

/** Resolve a root-to-leaf path and reject incomplete or cyclic hierarchies.
 * @param folders Loaded folders containing all ancestors of the requested path.
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

/** Replace one branch's visible page and discard descendants of unloaded parents.
 * @param folders Previously loaded folder metadata.
 * @param parentId Parent whose current page was read.
 * @param values Authoritative current page of that parent's children.
 * @returns Loaded metadata without old rows from this branch.
 */
export function replaceKnowledgeFolderBranch(folders: readonly KnowledgeFolder[], parentId: string | null,
  values: readonly KnowledgeFolder[]): readonly KnowledgeFolder[] {
  const removed = new Set(folders.filter(folder => folder.parentId === parentId).map(folder => folder.id))
  for (const folder of values) removed.delete(folder.id)
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) if (folder.parentId !== null && removed.has(folder.parentId) && !removed.has(folder.id)) {
      removed.add(folder.id); changed = true
    }
  }
  return [...folders.filter(folder => folder.parentId !== parentId && !removed.has(folder.id)), ...values]
}
