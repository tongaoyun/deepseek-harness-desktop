/** Startup collection of unreferenced content while no other product Host owns the store. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { expertKitGenerationPath, skillGenerationPath } from './content.ts'
import { parseTaskSnapshot } from './tasks.ts'
import { parseConnectorSnapshots } from './deepseek-harness-connector-contract.ts'

const digest = /^[a-f0-9]{64}$/u
const productId = /^[a-z][a-z0-9-]{2,63}$/u
const identity = z.object({ id: z.string().regex(productId), version: z.string().min(1).max(128),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/u) })
const identities = z.array(identity).refine(values => new Set(values.map(value => value.id)).size === values.length)
const sessionSnapshot = z.object({ employee: z.string().min(1), skills: z.array(z.unknown()),
  connectors: z.array(z.unknown()), digest: z.string().regex(digest) })

/** Establish process ownership and reclaim only validated, unreferenced generations.
 * @param root Private product content store, shared only by processes on this host.
 * @param report Default-enabled diagnostic sink; collection failures preserve reference files.
 * @param history Resolve retained and required snapshot files through official Session history.
 * Unavailable history or a missing required snapshot stops collection.
 * @returns Resolves after startup cleanup. Ownership remains until process exit, including plugin unloading,
 * so unfinished readers cannot race another Host's collection.
 */
export async function prepareProductContentStorage(root: string, report: (message: string) => void,
  history: () => Promise<{ readonly retainedFiles: ReadonlySet<string>; readonly requiredFiles: ReadonlySet<string> }>): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await directoryEntries(root)
  await withFileLock(join(root, 'content-startup'), async () => {
    const owners = join(root, 'content-owners')
    await mkdir(owners, { recursive: true, mode: 0o700 })
    let occupied = false
    for (const entry of await directoryEntries(owners)) {
      if (!entry.isFile() || !/^[1-9][0-9]*\.owner$/u.test(entry.name)) throw new Error('Invalid product content ownership record')
      const pid = Number(entry.name.slice(0, -6))
      if (!Number.isSafeInteger(pid)) throw new Error('Invalid product content owner PID')
      if (processExists(pid)) occupied = true
      else await rm(join(owners, entry.name))
    }
    const owner = join(owners, `${process.pid}.owner`)
    try { await writeFile(owner, '', { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error }
    if (occupied) return
    try {
      const sessions = await history()
      for (const path of sessions.requiredFiles) await boundedFile(path, 8 * 1024 * 1024)
      const references = await contentReferences(root, sessions.retainedFiles)
      const candidates = await contentGenerations(root)
      await cleanInstallationStages(root)
      for (const path of references.orphanRecords) await rm(path)
      for (const candidate of candidates) {
        if (references.content.has(candidate.path)) continue
        if (!await regularTree(candidate.path)) {
          report('Product content collection preserved a generation containing a link or special file')
          continue
        }
        const marker = join(candidate.path, '.deepseek-harness-sha256')
        try {
          if ((await boundedFile(marker, 128)).trim().toLowerCase() !== candidate.sha256) {
            report('Product content collection preserved a generation with an invalid checksum marker')
            continue
          }
        } catch (error) {
          report(`Product content collection preserved an unreadable generation marker: ${String(error)}`)
          continue
        }
        await rm(candidate.path, { recursive: true })
        try { await rmdir(dirname(candidate.path)) }
        catch (error) { if (!hasCode(error, 'ENOTEMPTY') && !hasCode(error, 'EEXIST')) throw error }
      }
    } catch (error) {
      report(`Product content collection stopped; remaining reference files and diagnostics were preserved: ${String(error)}`)
    }
  })
}

async function contentReferences(root: string, retainedFiles: ReadonlySet<string>) {
  const references = new Set<string>()
  const orphanRecords: string[] = []
  const retainSkills = (value: unknown) => {
    for (const skill of identities.parse(value)) references.add(skillGenerationPath(join(root, 'skills'), skill))
  }
  const retainKits = (value: unknown) => {
    for (const kit of identities.parse(value)) references.add(expertKitGenerationPath(join(root, 'expert-kits'), kit))
  }
  for (const entry of await directoryEntries(join(root, 'installed-skills-v1'))) {
    if (!entry.name.endsWith('.json')) continue
    const path = join(root, 'installed-skills-v1', entry.name)
    const value: unknown = JSON.parse(await boundedFile(path, 8 * 1024 * 1024))
    if (/^installed-[a-f0-9]{64}\.json$/u.test(entry.name)) retainSkills(value)
    else if (/^session-[a-f0-9]{64}\.json$/u.test(entry.name)) {
      const snapshot = sessionSnapshot.parse(value)
      const actual = createHash('sha256').update(JSON.stringify({ employee: snapshot.employee,
        skills: snapshot.skills, connectors: snapshot.connectors })).digest('hex')
      if (snapshot.digest !== actual) throw new Error('Invalid pinned skill snapshot digest')
      parseConnectorSnapshots(snapshot.connectors)
      identities.parse(snapshot.skills)
      if (retainedFiles.has(path)) retainSkills(snapshot.skills)
      else orphanRecords.push(path)
    } else throw new Error('Unrecognized skill reference filename')
  }
  for (const entry of await directoryEntries(join(root, 'installed-expert-kits-v1'))) {
    if (!entry.name.endsWith('.json')) continue
    if (!/^installed-[a-f0-9]{64}\.json$/u.test(entry.name)) throw new Error('Unrecognized kit reference filename')
    retainKits(JSON.parse(await boundedFile(join(root, 'installed-expert-kits-v1', entry.name), 8 * 1024 * 1024)))
  }
  const taskEntries = await directoryEntries(join(root, 'tasks-v1'))
  const taskDiagnostics = new Set(taskEntries.filter(entry => entry.name.endsWith('.diagnostic.json')).map(entry => entry.name))
  for (const entry of taskEntries) {
    if (entry.name.endsWith('.diagnostic.json') || !entry.name.endsWith('.json')) continue
    if (!/^product-task-[a-f0-9]{64}\.json$/u.test(entry.name)) throw new Error('Unrecognized task snapshot filename')
    const path = join(root, 'tasks-v1', entry.name)
    const snapshot = parseTaskSnapshot(await boundedFile(path, 2 * 1024 * 1024), entry.name)
    if (retainedFiles.has(path) || taskDiagnostics.has(`${entry.name}.diagnostic.json`)) {
      retainSkills(snapshot.capabilities.skills)
      if (snapshot.capabilities.expertKit !== undefined) retainKits([snapshot.capabilities.expertKit])
    } else orphanRecords.push(path)
  }
  return { content: references, orphanRecords }
}

async function contentGenerations(root: string): Promise<{ path: string; sha256: string }[]> {
  const candidates: { path: string; sha256: string }[] = []
  for (const generation of await directoryEntries(join(root, 'skills'))) {
    if (!generation.isDirectory() || !digest.test(generation.name)) continue
    const parent = join(root, 'skills', generation.name)
    for (const skill of await directoryEntries(parent)) {
      if (skill.isDirectory() && productId.test(skill.name)) candidates.push({ path: resolve(parent, skill.name), sha256: generation.name })
    }
  }
  for (const kit of await directoryEntries(join(root, 'expert-kits'))) {
    if (!kit.isDirectory() || !productId.test(kit.name)) continue
    const parent = join(root, 'expert-kits', kit.name)
    for (const generation of await directoryEntries(parent)) {
      if (generation.isDirectory() && digest.test(generation.name)) {
        candidates.push({ path: resolve(parent, generation.name), sha256: generation.name })
      }
    }
  }
  return candidates
}

async function boundedFile(path: string, maximum: number): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > maximum) throw new Error('Content reference is not a bounded regular file')
  const value = await readFile(path, 'utf8')
  if (Buffer.byteLength(value) > maximum) throw new Error('Content reference exceeds its byte limit')
  return value
}

async function directoryEntries(path: string) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('Content store directory is not a regular directory')
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
}

async function regularTree(path: string): Promise<boolean> {
  for (const entry of await directoryEntries(path)) {
    if (entry.isFile()) continue
    if (!entry.isDirectory() || !await regularTree(join(path, entry.name))) return false
  }
  return true
}

async function cleanInstallationStages(root: string): Promise<void> {
  for (const [directory, parentName, generationName] of [['skills', digest, productId], ['expert-kits', productId, digest]] as const) {
    for (const parent of await directoryEntries(join(root, directory))) {
      if (!parent.isDirectory() || !parentName.test(parent.name)) continue
      const path = join(root, directory, parent.name)
      for (const entry of await directoryEntries(path)) {
        const stage = /^(.*)\.installing-\d+-[a-z0-9]+$/u.exec(entry.name)?.[1]
        if (entry.isDirectory() && stage !== undefined && generationName.test(stage) && await regularTree(join(path, entry.name))) {
          await rm(join(path, entry.name), { recursive: true })
        }
      }
    }
  }
  for (const directory of ['tasks-v1', 'installed-skills-v1', 'installed-expert-kits-v1']) {
    for (const entry of await directoryEntries(join(root, directory))) {
      if (entry.isFile() && /^(?:product-task-|installed-|session-)[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/u.test(entry.name)) {
        await rm(join(root, directory, entry.name))
      }
    }
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    if (hasCode(error, 'ESRCH')) return false
    if (hasCode(error, 'EPERM')) return true
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
