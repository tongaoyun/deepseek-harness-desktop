import { describe, expect, it } from 'vitest'
import { allowedExtensionArtifacts } from './extensionPolicy'
import type { ExpertKitCatalogEntry, SkillCatalogEntry } from './types'

describe('extension execution policy', () => {
  it('pins every executable artifact to kind, current version and digest', () => {
    const kit = { id: 'ops', version: '1.2.0', sha256: 'a'.repeat(64) } as ExpertKitCatalogEntry
    const skill = { id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64) } as SkillCatalogEntry
    expect(allowedExtensionArtifacts([kit], [skill])).toEqual([
      { kind: 'expert-kit', id: 'ops', version: '1.2.0', sha256: 'a'.repeat(64) },
      { kind: 'skill', id: 'document-insight', version: '1.0.0', sha256: 'b'.repeat(64) },
    ])
  })

  it('fails closed when the control-plane catalogs are unavailable', () => {
    expect(allowedExtensionArtifacts([], [])).toEqual([])
  })
})
