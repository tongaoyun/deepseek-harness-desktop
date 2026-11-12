import { contentIndex, expertFiles, versionRef } from './content-fixtures.ts'
import { describe, expect, it } from 'vitest'
import { companyContentIndex, companyContentRelease, contentDigest } from '../src/company-content.ts'

const markdown = Buffer.from('---\nname: orders\ndescription: 查询公司订单\n---\n使用现有 MCP 查询订单。').toString('base64')
const files = { 'skills/orders/SKILL.md': markdown }
const release = (data: Record<string, string> = files) => ({ version: '1.0.0', sha256: contentDigest(data), files: data })

describe('company native content', () => {
  it('verifies catalog metadata without rewriting the published digest inputs', () => {
    const resource = { ...versionRef('experts/orders', expertFiles('orders')), catalog: { name: ' 订单顾问 ', division: '\u00a0operations\u00a0' } }
    const index = contentIndex('1.0.0', [resource])
    expect(companyContentIndex(index)).toEqual(index)
    expect(() => companyContentIndex({ ...index, resources: [{ ...resource, catalog: { name: resource.catalog.name.trim(), division: resource.catalog.division } }] })).toThrow('索引校验失败')
  })
  it('keeps skill descriptions within the published resource index limit', () => {
    const data = (size: number) => ({ 'skills/orders/SKILL.md': Buffer.from(`---\nname: orders\ndescription: ${'中'.repeat(size)}\n---\n核对订单`).toString('base64') })
    const valid = data(2000)
    expect(companyContentRelease(release(valid)).files).toEqual(valid)
    expect(() => companyContentRelease(release(data(2001)))).toThrow()
  })
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
  it('preserves nested SKILL.md examples as resources without parsing them as entry documents', () => {
    const data = { ...files,
      'skills/orders/references/示例/SKILL.md': Buffer.from('# 示例\n保留 {{literal}}。').toString('base64'),
      'skills/orders/assets/template/SKILL.md': Buffer.from('---\nname: another-skill\ndescription: Template\n---\nTemplate instructions.').toString('base64') }
    expect(companyContentRelease(release(data)).files).toEqual(data)
  })
  it.each(['orders', 'company-orders'])('preserves AgentSpec identifiers and complete package resources: %s', (name) => {
    const data = { ...expertFiles(name, 'Literal instructions'), [`experts/${name}/references/中文.txt`]: Buffer.from('参考资料').toString('base64'),
      [`experts/${name}/assets/template.bin`]: Buffer.from([0, 255, 17]).toString('base64') }
    expect(companyContentRelease(release(data)).files).toEqual(data)
    expect(() => companyContentRelease(release({ ...data, [`experts/${name}/config/SOUL.md`]: '' }))).toThrow('专家说明无效')
    expect(() => companyContentRelease(release({ ...data, [`experts/${name}/manifest.json`]: Buffer.from('{"worker":{"suggested_name":"wrong"},"description":"Orders"}').toString('base64') }))).toThrow()
  })
  it.each(['skills/orders/../../private', 'skills/orders/CON.txt', 'skills/orders/x.', 'skills/orders/.hidden/../x', 'experts/engineering/orders--invalid.md', 'skills/orders--invalid/SKILL.md', 'skills/orders-/SKILL.md'])('rejects unsafe paths: %s', (path) => {
    const data = { ...files, [path]: markdown }
    expect(() => companyContentRelease(release(data))).toThrow()
  })
  it.each([
    'references/订单?.md', 'assets/template*.xlsx', 'assets/"模板".txt', 'references/<订单>.md',
    'references/订单|库存.md', 'assets/template.xlsx ', 'references /说明.md', 'assets/目录?/模板.bin',
  ])('rejects nonportable skill and expert resource paths: %s', (path) => {
    for (const [root, entries] of [['skills/orders', files], ['experts/orders', expertFiles('orders', 'Read resources')]] as const) {
      const data = { ...entries, [`${root}/${path}`]: markdown }
      expect(() => companyContentRelease(release(data))).toThrow('非法路径')
    }
  })
  it('preserves Unicode and interior spaces in portable resource names', () => {
    const data = { ...files, ...expertFiles('orders', 'Read resources'),
      'skills/orders/references/订单 资料/核对 说明.md': markdown,
      'experts/orders/assets/订单 模板.xlsx': Buffer.from([0, 255]).toString('base64') }
    expect(companyContentRelease(release(data)).files).toEqual(data)
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
