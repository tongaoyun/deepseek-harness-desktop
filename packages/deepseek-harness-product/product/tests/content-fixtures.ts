import { createHash } from 'node:crypto'
import { contentDigest, type CompanyResourceVersion } from '../src/company-content.ts'
import { publishedTeamDocument } from '../src/company-team.ts'

export const encoded = (text: string) => Buffer.from(text).toString('base64')
export function expertFiles(id: string, soul = 'Follow the supplied instructions.') {
  return { [`experts/${id}/manifest.json`]: encoded(JSON.stringify({ worker: { suggested_name: id }, description: 'Expert instructions' })),
    [`experts/${id}/config/SOUL.md`]: encoded(soul) }
}
export function versionRef(
  resourceKey: string, files: Record<string, string>, dependencies: Record<string, string> = {},
): CompanyResourceVersion {
  const sha256 = contentDigest(files)
  return { resourceKey, sha256, version: `0.0.0-${sha256.slice(0, 56)}`, name: resourceKey.split('/')[1]!, description: 'Instructions',
    fileCount: Object.keys(files).length, publishedAt: '2026-11-04T00:00:00Z', catalog: {}, dependencies }
}
export function contentIndex(version: string, resources: CompanyResourceVersion[], dependencies: CompanyResourceVersion[] = []) {
  const records = [...resources.map(item => `resource\0${item.resourceKey}\0${item.version}\0${item.sha256}\n`),
    ...dependencies.map(item => `dependency\0${item.resourceKey}\0${item.version}\0${item.sha256}\n`),
    ...resources.flatMap(item => Object.entries(item.catalog).map(([key, value]) => `catalog\0${item.resourceKey}\0${key}\0${value}\n`))].sort().join('')
  return { protocolVersion: 2 as const, version, sha256: createHash('sha256').update(records).digest('hex'), resources, dependencies,
    publishedAt: '2026-11-04T00:00:00Z' }
}

export async function teamFixture(version = '1.0.0', instructions = '固定成员说明') {
  const { readFile } = await import('node:fs/promises')
  const document = publishedTeamDocument(await readFile(new URL('./fixtures/team.json', import.meta.url), 'utf8'))
  const payloads = new Map<string, Record<string, string>>()
  const experts = ['member-1', 'member-2'].map((id) => {
    const files = expertFiles(id, instructions + id), ref = versionRef('experts/' + id, files)
    payloads.set(ref.sha256, files); return ref
  })
  document.team.members = document.team.members.map((member, i) => ({
    ...member, expertVersion: experts[i]!.version, expertSha256: experts[i]!.sha256,
  }))
  const files = { 'teams/orders.json': encoded(JSON.stringify(document)) }
  const team = versionRef('teams/orders', files, Object.fromEntries(experts.map(ref => [ref.resourceKey, ref.sha256])))
  payloads.set(team.sha256, files)
  const index = contentIndex(version, [...experts, team], experts)
  const installedFiles: Record<string, string> = { ...files, 'catalog.json': encoded(JSON.stringify(index)) }
  for (const ref of experts) {
    for (const [path, value] of Object.entries(payloads.get(ref.sha256)!)) {
      installedFiles[path] = value
      installedFiles[path.replace('experts/' + ref.resourceKey.slice(8),
        'expert-versions/' + ref.resourceKey.slice(8) + '/' + ref.sha256)] = value
    }
  }
  return { index, payloads, files: installedFiles, document }
}
