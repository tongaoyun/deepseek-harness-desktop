/** Durable standalone Skill Preset descriptors and content generations. */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { ExpertKitConnectorSnapshotEntry } from './deepseek-harness-expert-kit-store.ts'

const SCHEMA = 'deepseek-harness.skill-preset.v2'
const PRESET_ID = /^deepseek-harness-skill-[0-9a-f]{12}$/u
const PRODUCT_ID = /^[a-z][a-z0-9-]{2,63}$/u
const SHA256 = /^[a-fA-F0-9]{64}$/u

export interface SkillSnapshotEntry {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly connectorRefs: readonly string[]
  readonly requiredTools: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly sha256: string
}

export interface SkillPresetSnapshot {
  readonly schema: typeof SCHEMA
  readonly id: string
  readonly skill: SkillSnapshotEntry
  readonly connectors: readonly ExpertKitConnectorSnapshotEntry[]
}

export function skillPresetId(
  skill: Pick<SkillSnapshotEntry, 'id' | 'sha256'>,
  connectors: readonly ExpertKitConnectorSnapshotEntry[],
): string {
  const connectorIdentity = [...connectors].sort((left, right) => left.id.localeCompare(right.id))
    .map(connector => [
      connector.id, connector.name, connector.transport, connector.url ?? '', connector.command ?? '',
      connector.arguments.join('\0'), connector.toolNames.join('\0'), connector.readOnlyTools.join('\0'),
    ].join('\u0001'))
  const identity = [`${skill.id}:${skill.sha256.toLowerCase()}`, '', ...connectorIdentity].join('\n')
  return `deepseek-harness-skill-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
}

export function skillGenerationPath(root: string, skill: Pick<SkillSnapshotEntry, 'id' | 'sha256'>): string {
  if (!PRODUCT_ID.test(skill.id) || !SHA256.test(skill.sha256)) throw new Error('invalid Skill entry')
  const generation = resolve(root, skill.sha256.toLowerCase())
  assertChild(root, generation)
  const target = resolve(generation, skill.id)
  assertChild(generation, target)
  return target
}

export async function writeSkillPresetSnapshot(
  root: string,
  skill: SkillSnapshotEntry,
  connectors: readonly ExpertKitConnectorSnapshotEntry[],
): Promise<string> {
  const normalized = normalizeSkill(skill)
  const normalizedConnectors = normalizeConnectors(connectors)
  const id = skillPresetId(normalized, normalizedConnectors)
  const snapshot: SkillPresetSnapshot = { schema: SCHEMA, id, skill: normalized, connectors: normalizedConnectors }
  await mkdir(root, { recursive: true })
  const target = resolve(root, `${id}.json`)
  assertChild(root, target)
  const content = `${JSON.stringify(snapshot, undefined, 2)}\n`
  try {
    const existing = await readFile(target, 'utf8')
    if (existing === content) return id
    throw new Error(`deepseek-harness product: Skill Preset snapshot ${id} is immutable`)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  const stage = resolve(root, `.${id}.${String(process.pid)}.${Date.now().toString(36)}.tmp`)
  assertChild(root, stage)
  try {
    await writeFile(stage, content, { encoding: 'utf8', mode: 0o600 })
    await rename(stage, target)
  } finally { await rm(stage, { force: true }) }
  return id
}

export async function readSkillPresetSnapshots(root: string): Promise<{
  readonly snapshots: readonly SkillPresetSnapshot[]
  readonly diagnostics: readonly string[]
}> {
  let files: string[]
  try {
    files = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name).sort()
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { snapshots: [], diagnostics: [] }
    throw error
  }
  const snapshots: SkillPresetSnapshot[] = []
  const diagnostics: string[] = []
  for (const file of files) {
    try {
      const value: unknown = JSON.parse(await readFile(resolve(root, file), 'utf8'))
      const snapshot = validateSnapshot(value)
      if (file !== `${snapshot.id}.json`) throw new Error('snapshot filename does not match its preset id')
      snapshots.push(snapshot)
    } catch (error) { diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return { snapshots, diagnostics }
}

export async function pruneSkillPresetSnapshots(root: string, retainedIds: ReadonlySet<string>): Promise<void> {
  let files: Dirent[]
  try { files = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
  await Promise.all(files.filter(file => file.isFile() && file.name.endsWith('.json')
    && !retainedIds.has(file.name.slice(0, -5))).map(file => rm(resolve(root, file.name), { force: true })))
}

export async function pruneSkillGenerations(root: string, retained: readonly SkillSnapshotEntry[]): Promise<void> {
  const retainedHashes = new Set(retained.map(skill => normalizeSkill(skill).sha256))
  let generations: Dirent[]
  try { generations = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
  for (const generation of generations) {
    if (!generation.isDirectory() || retainedHashes.has(generation.name.toLowerCase())) continue
    if (!SHA256.test(generation.name)) continue
    const target = resolve(root, generation.name)
    assertChild(root, target)
    await rm(target, { recursive: true, force: true })
  }
}

function validateSnapshot(value: unknown): SkillPresetSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Skill snapshot')
  const record = value as Record<string, unknown>
  if (record.schema !== SCHEMA || typeof record.id !== 'string' || !PRESET_ID.test(record.id)) {
    throw new Error('invalid Skill snapshot identity')
  }
  const skill = normalizeSkill(record.skill)
  const connectors = normalizeConnectors(record.connectors)
  if (skillPresetId(skill, connectors) !== record.id) throw new Error('Skill snapshot identity mismatch')
  return { schema: SCHEMA, id: record.id, skill, connectors }
}

function normalizeSkill(value: unknown): SkillSnapshotEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Skill entry')
  const record = value as Record<string, unknown>
  const skill = {
    id: record.id, name: record.name, version: record.version, summary: record.summary,
    connectorRefs: record.connectorRefs, requiredTools: record.requiredTools,
    knowledgeBaseRefs: record.knowledgeBaseRefs, sha256: record.sha256,
  }
  if (typeof skill.id !== 'string' || typeof skill.name !== 'string' || typeof skill.version !== 'string'
    || typeof skill.summary !== 'string' || typeof skill.sha256 !== 'string') {
    throw new Error('invalid Skill entry')
  }
  const normalized = {
    id: skill.id, name: skill.name, version: skill.version, summary: skill.summary,
    connectorRefs: stringList(skill.connectorRefs, 'connectorRefs'),
    requiredTools: stringList(skill.requiredTools, 'requiredTools'),
    knowledgeBaseRefs: stringList(skill.knowledgeBaseRefs, 'knowledgeBaseRefs'),
    sha256: skill.sha256.toLowerCase(),
  }
  validateSkill(normalized)
  return normalized
}

function validateSkill(skill: SkillSnapshotEntry): void {
  if (!PRODUCT_ID.test(skill.id) || skill.name === '' || skill.version === '' || skill.summary === ''
    || !SHA256.test(skill.sha256)) throw new Error('invalid Skill entry')
}

function normalizeConnectors(value: unknown): ExpertKitConnectorSnapshotEntry[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('invalid Skill connector snapshots')
  const connectors = value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('invalid Skill connector snapshot')
    const record = item as Record<string, unknown>
    const transport = record.transport
    if (transport !== 'streamable-http' && transport !== 'stdio') throw new Error('invalid Skill connector transport')
    const id = stringField(record.id, 'connector id')
    const connector: ExpertKitConnectorSnapshotEntry = {
      id, name: stringField(record.name, 'connector name'), transport,
      arguments: stringList(record.arguments, 'connector arguments'),
      toolNames: stringList(record.toolNames, 'connector tools'),
      readOnlyTools: stringList(record.readOnlyTools, 'connector read-only tools'),
      ...(transport === 'streamable-http'
        ? { url: stringField(record.url, 'connector URL') }
        : { command: stringField(record.command, 'connector command') }),
    }
    if (!PRODUCT_ID.test(id) || connector.toolNames.length === 0
      || new Set(connector.toolNames).size !== connector.toolNames.length
      || connector.readOnlyTools.some(tool => !connector.toolNames.includes(tool))) {
      throw new Error(`invalid Skill connector snapshot ${id}`)
    }
    return connector
  })
  if (new Set(connectors.map(connector => connector.id)).size !== connectors.length) {
    throw new Error('duplicate Skill connector snapshot id')
  }
  return connectors
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256
    || value.some(item => typeof item !== 'string' || item === '')) throw new Error(`invalid ${field}`)
  return value.map(item => String(item))
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${field}`)
  return value
}

function assertChild(parent: string, child: string): void {
  if (!resolve(child).startsWith(resolve(parent) + sep)) throw new Error('Skill path escaped its product root')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
