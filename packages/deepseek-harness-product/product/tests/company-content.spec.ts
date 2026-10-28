import { describe, expect, it } from 'vitest'
import { companyContentRelease, contentDigest } from '../src/company-content.ts'

const markdown = Buffer.from('---\nname: orders\ndescription: 查询公司订单\n---\n使用现有 MCP 查询订单。').toString('base64')
const files = { 'skills/orders/SKILL.md': markdown }
const release = (data: Record<string, string> = files) => ({ version: '1.0.0', sha256: contentDigest(data), files: data })

describe('company native content', () => {
  it('rejects deeply nested metadata before converting YAML to objects', () => {
    for (const depth of [64, 10000]) {
      const data = { 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\ndescription: Orders\nextra: ${'['.repeat(depth)}0${']'.repeat(depth)}\n---\nUse tools.`).toString('base64') }
      expect(() => companyContentRelease(release(data))).toThrow(/公司技能 YAML (?:格式无效|嵌套最多 64 层)/u)
    }
    const data = { 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\ndescription: Orders\nextra: ${'['.repeat(63)}0${']'.repeat(63)}\n---\nUse tools.`).toString('base64') }
    expect(companyContentRelease(release(data)).files).toEqual(data)
  })
  it.each([
    'description: null', 'description: true', 'description: 123', 'description: "unterminated',
    'description: Orders\nextra: [broken', 'description: Orders\nextra: one\nextra: two',
    'description: Orders\ndisable-model-invocation: maybe',
    'description: Orders\nuserInvocable: true',
    'description: &text Orders\nextra: *text',
    'description: !unsupported Orders',
  ])('rejects metadata ignored by the native skill provider: %s', (metadata) => {
    const data = { 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\n${metadata}\n---\nUse the configured tools.`).toString('base64') }
    expect(() => companyContentRelease(release(data))).toThrow()
  })
  it.each([
    'description: 查询订单 # author comment',
    'description: "查询\\u8ba2\\u5355"',
    'description: \'查询订单\'\ndisable-model-invocation: YES\nuser-invocable: 0',
  ])('preserves valid native YAML and invocation metadata: %s', (metadata) => {
    const data = { 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders # directory name\n${metadata}\n---\nUse the configured tools.`).toString('base64') }
    expect(companyContentRelease(release(data)).files).toEqual(data)
  })
  it('accepts standard files and a canonical digest, and represents an unpublished company explicitly', () => {
    expect(companyContentRelease(release())).toEqual(release())
    expect(companyContentRelease(null).files).toEqual({})
  })
  it.each(['orders', 'company-orders'])('preserves expert and skill names without assigning a company prefix: %s', (name) => {
    const document = Buffer.from(`---\nname: ${name}\ndescription: Orders\n---\nUse the configured tools.`).toString('base64')
    const data = { [`experts/operations/${name}.md`]: document, [`skills/${name}/SKILL.md`]: document }
    expect(companyContentRelease(release(data)).files).toEqual(data)
  })
  it('uses native YAML semantics for expert metadata and binds the name to the file', () => {
    const document = (header: string) => Buffer.from(`---\n${header}\n---\nUse the configured tools.`).toString('base64')
    const quoted = { 'experts/operations/orders.md': document('name: orders # stable id\ndescription: "查询订单"') }
    expect(companyContentRelease(release(quoted)).files).toEqual(quoted)
    expect(() => companyContentRelease(release({
      'experts/operations/orders.md': document('name: other\ndescription: Orders'),
    }))).toThrow('公司专家必须包含与文件名一致')
    expect(() => companyContentRelease(release({
      'experts/operations/orders.md': document('name: orders\ndescription: [broken'),
    }))).toThrow('公司专家 YAML 格式无效')
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
  it.each(['skills/orders/assets', 'skills/orders/Assets'])(
    'rejects a file that is also a resource directory before installation: %s', (parent) => {
      const data = { ...files, [parent]: Buffer.from('file').toString('base64'),
        'skills/orders/assets/policy.txt': Buffer.from('policy').toString('base64') }
      expect(() => companyContentRelease(release(data))).toThrow('文件与目录路径冲突')
    },
  )
  it.each([
    ['assets/Policies/one.txt', 'assets/policies/two.txt'],
    ['Assets/one.txt', 'assets/two.txt'],
  ])('rejects differently cased aliases of the same resource directory: %s, %s', (left, right) => {
    const data = { ...files, [`skills/orders/${left}`]: markdown, [`skills/orders/${right}`]: markdown }
    expect(() => companyContentRelease(release(data))).toThrow('目录大小写冲突')
  })
  it('accepts consistently cased shared resource directories', () => {
    const data = { ...files, 'skills/orders/Assets/one.txt': markdown, 'skills/orders/Assets/two.txt': markdown }
    expect(companyContentRelease(release(data)).files).toEqual(data)
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
