/** Durable Expert Kit artifact generations and product capability snapshots. */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const SNAPSHOT_SCHEMA = 'deepseek-harness.expert-kit-preset.v2'
const MAX_SNAPSHOT_BYTES = 1024 * 1024
const PRESET_ID = /^deepseek-harness-enabled-[0-9a-f]{12}$/u
const PRODUCT_ID = /^[a-z][a-z0-9-]{2,63}$/u
const SHA256 = /^[a-fA-F0-9]{64}$/u

/** Catalog data required to reconstruct one immutable Expert Kit generation. */
export interface ExpertKitSnapshotEntry {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly summary: string
  readonly skillIds: readonly string[]
  readonly connectorRefs: readonly string[]
  readonly requiredTools: readonly string[]
  readonly knowledgeBaseRefs: readonly string[]
  readonly sha256: string
}

/** Non-secret MCP configuration retained with one Expert Kit Preset generation. */
export interface ExpertKitConnectorSnapshotEntry {
  readonly id: string
  readonly name: string
  readonly transport: 'streamable-http' | 'stdio'
  readonly url?: string
  readonly command?: string
  readonly arguments: readonly string[]
  readonly toolNames: readonly string[]
  readonly readOnlyTools: readonly string[]
}

/** Non-secret descriptor used to restore an Expert Kit Preset after Host restart. */
export interface ExpertKitPresetSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA
  readonly id: string
  readonly kits: readonly ExpertKitSnapshotEntry[]
  readonly connectors: readonly ExpertKitConnectorSnapshotEntry[]
}

/** Snapshot files that passed validation plus diagnostics for isolated corrupt files. */
export interface ExpertKitSnapshotReadResult {
  readonly snapshots: readonly ExpertKitPresetSnapshot[]
  readonly diagnostics: readonly string[]
}

/** Stable Preset identity for a sorted set of Expert Kit artifact generations. */
export function enabledExpertKitPresetId(
  kits: readonly Pick<ExpertKitSnapshotEntry, 'id' | 'sha256'>[],
  connectors: readonly ExpertKitConnectorSnapshotEntry[],
): string {
  const kitIdentity = [...kits].sort((left, right) => left.id.localeCompare(right.id))
    .map(kit => `${kit.id}:${kit.sha256.toLowerCase()}`)
  const connectorIdentity = [...connectors].sort((left, right) => left.id.localeCompare(right.id))
    .map(connector => [
      connector.id, connector.name, connector.transport, connector.url ?? '', connector.command ?? '',
      connector.arguments.join('\0'), connector.toolNames.join('\0'), connector.readOnlyTools.join('\0'),
    ].join('\u0001'))
  const identity = [...kitIdentity, '', ...connectorIdentity].join('\n')
  return `deepseek-harness-enabled-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`
}

/** Resolve the immutable content-addressed directory for one Expert Kit generation. */
export function expertKitGenerationPath(root: string, kit: Pick<ExpertKitSnapshotEntry, 'id' | 'sha256'>): string {
  validateProductId(kit.id)
  validateSha256(kit.sha256)
  const parent = resolve(root, kit.id)
  assertChild(root, parent)
  const target = resolve(parent, kit.sha256.toLowerCase())
  assertChild(parent, target)
  return target
}

/** Persist one validated snapshot atomically without storing connector credentials. */
export async function writeExpertKitPresetSnapshot(
  root: string,
  input: Omit<ExpertKitPresetSnapshot, 'schema'>,
): Promise<void> {
  const snapshot = validateSnapshot({ ...input, schema: SNAPSHOT_SCHEMA })
  await mkdir(root, { recursive: true })
  const target = resolve(root, `${snapshot.id}.json`)
  assertChild(root, target)
  const content = `${JSON.stringify(snapshot, undefined, 2)}\n`
  try {
    const existing = await readFile(target, 'utf8')
    if (existing === content) return
    throw new Error(`deepseek-harness product: Expert Kit Preset snapshot ${snapshot.id} is immutable`)
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error
  }
  const stage = resolve(root, `.${snapshot.id}.${String(process.pid)}.${Date.now().toString(36)}.tmp`)
  assertChild(root, stage)
  try {
    await writeFile(stage, content, { encoding: 'utf8', mode: 0o600 })
    await rename(stage, target)
  } finally {
    await rm(stage, { force: true })
  }
}

/** Read valid snapshot descriptors while isolating corrupt local files. */
export async function readExpertKitPresetSnapshots(root: string): Promise<ExpertKitSnapshotReadResult> {
  let files: string[]
  try {
    files = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name).sort()
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { snapshots: [], diagnostics: [] }
    throw error
  }
  const snapshots: ExpertKitPresetSnapshot[] = []
  const diagnostics: string[] = []
  for (const file of files) {
    const path = resolve(root, file)
    assertChild(root, path)
    try {
      const source = await readFile(path, 'utf8')
      if (Buffer.byteLength(source, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds size limit')
      const snapshot = validateSnapshot(JSON.parse(source) as unknown)
      if (file !== `${snapshot.id}.json`) throw new Error('snapshot filename does not match its preset id')
      snapshots.push(snapshot)
    } catch (error) {
      diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { snapshots, diagnostics }
}

/** Remove Preset descriptors that no current selection or Session references. */
export async function pruneExpertKitPresetSnapshots(
  root: string,
  retainedIds: ReadonlySet<string>,
): Promise<void> {
  let entries: Dirent[]
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (retainedIds.has(id)) continue
    const path = resolve(root, entry.name)
    assertChild(root, path)
    await rm(path, { force: true })
  }
}

/** Remove immutable artifact generations absent from the current catalog and retained Presets. */
export async function pruneExpertKitGenerations(
  root: string,
  retained: readonly Pick<ExpertKitSnapshotEntry, 'id' | 'sha256'>[],
): Promise<void> {
  const retainedByKit = new Map<string, Set<string>>()
  for (const kit of retained) {
    validateProductId(kit.id)
    validateSha256(kit.sha256)
    const generations = retainedByKit.get(kit.id) ?? new Set<string>()
    generations.add(kit.sha256.toLowerCase())
    retainedByKit.set(kit.id, generations)
  }
  let kits: Dirent[]
  try { kits = await readdir(root, { withFileTypes: true }) }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return
    throw error
  }
  for (const kit of kits) {
    if (!kit.isDirectory()) continue
    const kitRoot = resolve(root, kit.name)
    assertChild(root, kitRoot)
    const retainedGenerations = retainedByKit.get(kit.name) ?? new Set<string>()
    const generations = await readdir(kitRoot, { withFileTypes: true })
    for (const generation of generations) {
      if (!generation.isDirectory()) continue
      if (retainedGenerations.has(generation.name.toLowerCase())) continue
      if (!SHA256.test(generation.name) && !generation.name.includes('.installing-')) continue
      const path = resolve(kitRoot, generation.name)
      assertChild(kitRoot, path)
      await rm(path, { recursive: true, force: true })
    }
    if ((await readdir(kitRoot)).length === 0) await rm(kitRoot, { force: true })
  }
}

function validateSnapshot(value: unknown): ExpertKitPresetSnapshot {
  const record = objectRecord(value, 'Expert Kit Preset snapshot')
  if (record.schema !== SNAPSHOT_SCHEMA) throw new Error('unsupported Expert Kit Preset snapshot schema')
  const id = stringField(record, 'id')
  if (!PRESET_ID.test(id)) throw new Error(`invalid Expert Kit Preset id ${id}`)
  if (!Array.isArray(record.kits) || record.kits.length === 0 || record.kits.length > 256) {
    throw new Error('Expert Kit Preset snapshot requires between 1 and 256 kits')
  }
  const kits = record.kits.map(expertKitEntry)
  if (new Set(kits.map(kit => kit.id)).size !== kits.length) throw new Error('duplicate Expert Kit snapshot id')
  if (!Array.isArray(record.connectors) || record.connectors.length > 256) {
    throw new Error('Expert Kit Preset snapshot has invalid connectors')
  }
  const connectors = record.connectors.map(connectorEntry)
  if (new Set(connectors.map(connector => connector.id)).size !== connectors.length) {
    throw new Error('duplicate Expert Kit connector snapshot id')
  }
  if (enabledExpertKitPresetId(kits, connectors) !== id) throw new Error('Expert Kit Preset snapshot identity mismatch')
  return { schema: SNAPSHOT_SCHEMA, id, kits, connectors }
}

function expertKitEntry(value: unknown): ExpertKitSnapshotEntry {
  const record = objectRecord(value, 'Expert Kit snapshot entry')
  const id = stringField(record, 'id')
  const sha256 = stringField(record, 'sha256')
  validateProductId(id)
  validateSha256(sha256)
  return {
    id, name: stringField(record, 'name'), version: stringField(record, 'version'),
    summary: stringField(record, 'summary'), skillIds: stringList(record.skillIds, 'skillIds'),
    connectorRefs: stringList(record.connectorRefs, 'connectorRefs'),
    requiredTools: stringList(record.requiredTools, 'requiredTools'),
    knowledgeBaseRefs: stringList(record.knowledgeBaseRefs, 'knowledgeBaseRefs'),
    sha256: sha256.toLowerCase(),
  }
}

function connectorEntry(value: unknown): ExpertKitConnectorSnapshotEntry {
  const record = objectRecord(value, 'Expert Kit connector snapshot entry')
  const transport = stringField(record, 'transport')
  if (transport !== 'streamable-http' && transport !== 'stdio') throw new Error('invalid connector transport')
  const entry: ExpertKitConnectorSnapshotEntry = {
    id: stringField(record, 'id'), name: stringField(record, 'name'), transport,
    arguments: stringList(record.arguments, 'arguments'), toolNames: stringList(record.toolNames, 'toolNames'),
    readOnlyTools: stringList(record.readOnlyTools, 'readOnlyTools'),
    ...(transport === 'streamable-http'
      ? { url: stringField(record, 'url') }
      : { command: stringField(record, 'command') }),
  }
  validateProductId(entry.id)
  if (entry.toolNames.length === 0 || new Set(entry.toolNames).size !== entry.toolNames.length
    || new Set(entry.readOnlyTools).size !== entry.readOnlyTools.length
    || entry.readOnlyTools.some(tool => !entry.toolNames.includes(tool))) {
    throw new Error(`invalid connector tools for ${entry.id}`)
  }
  return entry
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`invalid ${label}`)
  return value as Record<string, unknown>
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') throw new Error(`invalid ${field}`)
  return value
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 256
    || value.some(item => typeof item !== 'string' || item === '')) throw new Error(`invalid ${field}`)
  return value.map(item => String(item))
}

function validateProductId(id: string): void {
  if (!PRODUCT_ID.test(id)) throw new Error(`deepseek-harness product: invalid product id ${id}`)
}

function validateSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error('deepseek-harness product: invalid artifact SHA-256')
}

function assertChild(parent: string, child: string): void {
  const prefix = resolve(parent) + sep
  if (!resolve(child).startsWith(prefix)) throw new Error('deepseek-harness product: path escaped its product root')
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
