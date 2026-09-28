/** Stable product capability snapshots used to select an official Harness preset. */

import { createHash } from 'node:crypto'

/** Product capabilities selected for one stable Harness preset. */
export interface CapabilitySnapshot {
  readonly expertKitId?: string
  readonly skillIds: readonly string[]
  readonly connectorRefs: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly planMode: boolean
  readonly browser: boolean
  readonly office: boolean
}

function normalize(snapshot: CapabilitySnapshot): CapabilitySnapshot {
  return {
    ...(snapshot.expertKitId === undefined ? {} : { expertKitId: snapshot.expertKitId }),
    skillIds: [...new Set(snapshot.skillIds)].sort(),
    connectorRefs: [...new Set(snapshot.connectorRefs)].sort(),
    knowledgeBaseRefs: [...new Set(snapshot.knowledgeBaseRefs)].sort(),
    planMode: snapshot.planMode,
    browser: snapshot.browser,
    office: snapshot.office,
  }
}

/** Serialize a capability snapshot in a deterministic order.
 * @param snapshot - Product capability selection.
 * @returns Stable serialized snapshot.
 */
export function stableCapabilitySnapshot(snapshot: CapabilitySnapshot): string {
  return JSON.stringify(normalize(snapshot))
}

/** Derive the stable SHA-256 preset identity for a capability snapshot.
 * @param snapshot - Product capability selection.
 * @returns Hexadecimal preset identity.
 */
export function capabilityPresetId(snapshot: CapabilitySnapshot): string {
  return createHash('sha256').update(stableCapabilitySnapshot(snapshot)).digest('hex')
}
