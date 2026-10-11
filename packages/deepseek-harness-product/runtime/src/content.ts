/** Immutable product content metadata and installation paths, independent of Presets. */
import { resolve } from 'node:path'

/** Catalog fields pinned when a task selects a Skill. */
export interface SkillContent {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly connectorRefs: readonly string[]
  readonly requiredTools: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly sha256: string
}

/** Catalog fields pinned when a task selects an Expert Kit. */
export interface ExpertKitContent extends SkillContent {
  readonly minimumDesktopVersion?: string
  readonly skillIds: readonly string[]
}

/** Locate an immutable kit generation without registering an execution composition.
 * @param root Product kit content directory.
 * @param kit Catalog identity with a validated content digest.
 * @returns Absolute path containing this kit's README and bundled skills.
 */
export function expertKitGenerationPath(root: string, kit: Pick<ExpertKitContent, 'id' | 'sha256'>): string {
  validateIdentity(kit)
  return resolve(root, kit.id, kit.sha256.toLowerCase())
}

/** Locate an immutable standalone skill generation.
 * @param root Product skill content directory.
 * @param skill Catalog identity with a validated content digest.
 * @returns Absolute path containing this skill's SKILL.md and resources.
 */
export function skillGenerationPath(root: string, skill: Pick<SkillContent, 'id' | 'sha256'>): string {
  validateIdentity(skill)
  return resolve(root, skill.sha256.toLowerCase(), skill.id)
}

function validateIdentity(content: Pick<SkillContent, 'id' | 'sha256'>): void {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(content.id) || !/^[a-fA-F0-9]{64}$/.test(content.sha256)) {
    throw new Error('Invalid product content identity')
  }
}
