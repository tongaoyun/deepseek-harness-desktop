import { describe, expect, it } from 'vitest'
import { extractArtifactReferences } from './RichMessage'

describe('rich message artifacts', () => {
  it('extracts unique Windows and Unix office output paths', () => {
    const values = extractArtifactReferences('已生成 C:\\Reports\\sales.xlsx 和 /tmp/summary.pdf。重复 C:\\Reports\\sales.xlsx')
    expect(values).toHaveLength(2)
    expect(values[0]).toMatchObject({ name: 'sales.xlsx', kind: 'sheet' })
    expect(values[1]).toMatchObject({ name: 'summary.pdf', kind: 'document' })
  })
})
