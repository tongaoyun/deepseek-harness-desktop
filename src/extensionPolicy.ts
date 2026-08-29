import type { AllowedExtensionArtifact, ExpertKitCatalogEntry, SkillCatalogEntry } from './types'

export function allowedExtensionArtifacts(
  expertKits: ExpertKitCatalogEntry[],
  skills: SkillCatalogEntry[],
): AllowedExtensionArtifact[] {
  return [
    ...expertKits.map((artifact) => ({
      kind: 'expert-kit' as const,
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
    })),
    ...skills.map((artifact) => ({
      kind: 'skill' as const,
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
    })),
  ]
}
