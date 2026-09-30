/** Model-only Expert Kit instructions loaded directly from packaged README files. */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

const PROVIDER_NAME = 'deepseek-harness-expert-kit-readme'
const MAX_README_BYTES = 64 * 1024
const INVOCATION = { modelInvocable: true, userInvocable: false } as const

/** One enabled Expert Kit README exposed to the model-facing skill catalog. */
export interface ExpertKitReadmeEntry {
  /** Collision-resistant kebab-case name used only by the model-facing skill loader. */
  readonly name: string
  /** Short routing summary included in the Session skill catalog. */
  readonly description: string
  /** Absolute path to the installed Expert Kit README. */
  readonly path: string
}

/** Expert Kit README provider configuration for one immutable Agent Preset. */
export interface Config {
  /** README entries belonging to the Preset's enabled Expert Kits. */
  readonly entries: readonly ExpertKitReadmeEntry[]
}

interface ResolvedEntry extends ExpertKitReadmeEntry {
  readonly resourceDirectory: string
}

/** Cordis plugin name. */
export const name = 'deepseek-harness-expert-kit-readme'
/** Harness service required by this provider. */
export const inject = ['skills']

/** Register enabled Expert Kit READMEs as model-only, lazily loaded Harness skills.
 * @param ctx - Preset-scoped Cordis context.
 * @param config - Installed README paths and routing summaries.
 * @returns A promise that settles after every README path is validated and the provider is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = await resolveEntries(config.entries)
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const candidates = entries.map(candidate)
  ctx.skills.registerProvider((): SkillProvider => ({
    name: PROVIDER_NAME,
    list: () => Promise.resolve(candidates),
    async get(selected, options): Promise<SkillDefinition | undefined> {
      const entry = byName.get(selected.name)
      if (entry === undefined || selected.provider !== PROVIDER_NAME) return undefined
      const content = await readFile(entry.path, { encoding: 'utf8', signal: options.signal })
      if (Buffer.byteLength(content, 'utf8') > MAX_README_BYTES) {
        throw new Error(`Expert Kit README exceeds ${String(MAX_README_BYTES)} bytes: ${entry.path}`)
      }
      return definition(entry, content)
    },
  }))
}

async function resolveEntries(entries: readonly ExpertKitReadmeEntry[]): Promise<readonly ResolvedEntry[]> {
  const names = new Set<string>()
  return await Promise.all(entries.map(async (entry) => {
    if (!isSkillName(entry.name)) throw new Error(`Invalid Expert Kit README skill name: ${entry.name}`)
    if (names.has(entry.name)) throw new Error(`Duplicate Expert Kit README skill name: ${entry.name}`)
    names.add(entry.name)
    if (entry.description.trim() === '') throw new Error(`Expert Kit README ${entry.name} requires a description`)
    if (!isAbsolute(entry.path) || !['README.md', 'readme.md'].includes(basename(entry.path))) {
      throw new Error(`Expert Kit README ${entry.name} requires an absolute README.md path`)
    }
    const path = await realpath(entry.path)
    const metadata = await stat(path)
    if (!metadata.isFile()) throw new Error(`Expert Kit README is not a file: ${path}`)
    if (metadata.size > MAX_README_BYTES) {
      throw new Error(`Expert Kit README exceeds ${String(MAX_README_BYTES)} bytes: ${path}`)
    }
    return { ...entry, path, resourceDirectory: dirname(path) }
  }))
}

function candidate(entry: ResolvedEntry): SkillCandidate {
  return {
    name: entry.name,
    description: entry.description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'preset',
    resourceBase: { kind: 'directory', path: entry.resourceDirectory },
    path: entry.path,
    rank: BUNDLED_SKILL_RANK,
    locator: entry.name,
  }
}

function definition(entry: ResolvedEntry, content: string): SkillDefinition {
  return {
    name: entry.name,
    description: entry.description,
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'preset',
    resourceBase: { kind: 'directory', path: entry.resourceDirectory },
    path: entry.path,
    content,
  }
}
