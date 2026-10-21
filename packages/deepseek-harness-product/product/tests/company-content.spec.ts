import { describe, expect, it } from 'vitest'
import { companyContentRelease, contentDigest } from '../src/company-content.ts'

const markdown = Buffer.from('---\nname: orders\ndescription: 查询公司订单\n---\n使用现有 MCP 查询订单。').toString('base64')
const files = { 'skills/orders/SKILL.md': markdown }
const release = (data: Record<string, string> = files) => ({ version: '1.0.0', sha256: contentDigest(data), files: data })

describe('company native content', () => {
  it('accepts standard files and a canonical digest, and represents an unpublished company explicitly', () => {
    expect(companyContentRelease(release())).toEqual(release())
    expect(companyContentRelease(null).files).toEqual({})
  })
  it.each(['orders', 'company-orders'])('preserves expert and skill names without assigning a company prefix: %s', (name) => {
    const document = Buffer.from(`---\nname: ${name}\ndescription: Orders\n---\nUse the configured tools.`).toString('base64')
    const data = { [`experts/operations/${name}.md`]: document, [`skills/${name}/SKILL.md`]: document }
    expect(companyContentRelease(release(data)).files).toEqual(data)
  })
  it.each(['skills/orders/../../private', 'skills/orders/CON.txt', 'skills/orders/x.', 'skills/orders/.hidden/../x', 'experts/engineering/orders--invalid.md', 'skills/orders--invalid/SKILL.md', 'skills/orders-/SKILL.md'])('rejects unsafe paths: %s', (path) => {
    const data = { ...files, [path]: markdown }
    expect(() => companyContentRelease(release(data))).toThrow()
  })
  it('rejects corrupted bytes, missing entry documents, and case collisions', () => {
    expect(() => companyContentRelease({ ...release(), sha256: '0'.repeat(64) })).toThrow()
    expect(() => companyContentRelease(release({ 'skills/orders/file.txt': markdown }))).toThrow()
    expect(() => companyContentRelease(release({ ...files, 'skills/orders/skill.md': markdown }))).toThrow()
    expect(() => companyContentRelease(release({ ...files, 'skills/orders/file.txt': 'not base64!' }))).toThrow()
  })
})

it('rejects missing responses and native entries that would be silently ignored', () => {
  expect(() => companyContentRelease(undefined)).toThrow()
  for (const document of ['no metadata', '---\nname: wrong\ndescription: orders\n---\nbody',
    '---\nname: orders\ndescription: orders\n---\n  ']) {
    expect(() => companyContentRelease(release({ 'skills/orders/SKILL.md': Buffer.from(document).toString('base64') }))).toThrow()
  }
  expect(() => companyContentRelease(release({ 'experts/a/orders.md': markdown, 'experts/b/orders.md': markdown }))).toThrow()
})
