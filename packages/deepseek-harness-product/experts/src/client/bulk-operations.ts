/** Bulk changes merge a frozen target set into the latest personal selection. */
import type { AgencyAgentsEnabledState } from './remote.ts'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

type BulkRemote = Pick<TypertRemoteNamespaceMap['agencyAgents'], 'getCatalog' | 'setEnabled'>
/** Apply only confirmed targets, preserving changes made elsewhere while confirmation was open.
 * @param remote - Current catalog and revision-checked write operations.
 * @param targets - Slugs shown in the confirmation.
 * @param enabled - Desired personal activation state.
 * @returns Committed selection; rejects on read/write conflicts without an automatic overwrite.
 */
export async function commitBulk(
  remote: BulkRemote,
  targets: readonly string[],
  enabled: boolean,
  signal?: AbortSignal,
): Promise<AgencyAgentsEnabledState> {
  signal?.throwIfAborted()
  const catalog = await remote.getCatalog(false, signal)
  if (!catalog.ok) throw catalog.error
  const available = new Set(catalog.value.experts.filter(expert => !expert.conflict && !expert.teamMember).map(expert => expert.slug))
  const next = new Set(catalog.value.enabled)
  for (const slug of targets) if (available.has(slug)) { if (enabled) next.add(slug); else next.delete(slug) }
  signal?.throwIfAborted()
  const result = signal === undefined
    ? await remote.setEnabled([...next], catalog.value.revision)
    : await remote.setEnabled([...next], catalog.value.revision, signal)
  if (!result.ok) throw result.error
  signal?.throwIfAborted()
  return result.value
}
