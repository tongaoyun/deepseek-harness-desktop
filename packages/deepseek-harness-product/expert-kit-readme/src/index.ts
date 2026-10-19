/** Model-only Expert Kit instructions loaded directly from packaged README files. */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  renderSkillContent,
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
  /** Live catalog resource identity; file contents remain pinned to the installed generation. */
  readonly expertKitId?: string
  /** README entries belonging to the Preset's enabled Expert Kits. */
  readonly entries: readonly ExpertKitReadmeEntry[]
}

/** Selected kit content committed by the official pre-step message pipeline. */
export interface ExpertKitInstructionSource {
  readonly kind: 'product-expert-kit-instructions'
  readonly form: 'instructions'
  readonly expertKitId: string
  readonly names: readonly string[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Instructions remain ordinary message text when this product producer is absent.
     * @persistenceAttribution
     */
    'product-expert-kit-instructions': ExpertKitInstructionSource
  }
}

interface ResolvedEntry extends ExpertKitReadmeEntry {
  readonly resourceDirectory: string
}

/** Cordis plugin name. */
export const name = 'deepseek-harness-expert-kit-readme'
/** Harness service required by this provider. */
export const inject = ['skills']

/** Register pinned kit content and enter its guide before model execution.
 * @param ctx - Preset-scoped Cordis context.
 * @param config - Installed README paths and routing summaries.
 * @returns A promise that settles after every README path is validated and the provider is registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = await resolveEntries(config.entries)
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  const candidates = entries.map(candidate)
  const selectionId = config.expertKitId ?? name
  const authorize = async (signal?: AbortSignal) => {
    if (config.expertKitId === undefined) return
    const data = ctx.get('productData') as { invoke(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> } | undefined
    if (data === undefined) throw new Error('Expert Kit authorization service is unavailable')
    await data.invoke('expertKits.get', { id: config.expertKitId }, signal)
  }
  ctx.skills.registerProvider((): SkillProvider => ({
    name: PROVIDER_NAME,
    async list(options) { await authorize(options.signal); return candidates },
    async get(selected, options): Promise<SkillDefinition | undefined> {
      const entry = byName.get(selected.name)
      if (entry === undefined || selected.provider !== PROVIDER_NAME) return undefined
      await authorize(options.signal)
      const content = await readFile(entry.path, { encoding: 'utf8', signal: options.signal })
      if (Buffer.byteLength(content, 'utf8') > MAX_README_BYTES) {
        throw new Error(`Expert Kit README exceeds ${String(MAX_README_BYTES)} bytes: ${entry.path}`)
      }
      return definition(entry, content)
    },
  }))
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    await authorize(signal)
    const names = entries.map(entry => entry.name)
    const loaded = (source: MessageSource) => source.kind === 'product-expert-kit-instructions'
      && source.expertKitId === selectionId && names.every(name => source.names.includes(name))
    if (names.length === 0) return decision
    if (agent.session.deriveMessages().some(message => message.role === 'user' && loaded(message.source))
      || decision.messages.some(message => loaded(message.source))) return decision
    const contents: string[] = []
    for (const entry of entries) {
      const content = await readFile(entry.path, { encoding: 'utf8', signal })
      if (Buffer.byteLength(content, 'utf8') > MAX_README_BYTES) throw new Error('Expert Kit README exceeds the package limit')
      contents.push(renderSkillContent(definition(entry, content)))
    }
    signal.throwIfAborted()
    return { ...decision, messages: [...decision.messages, createUserMessage({
      content: [{ type: 'text', text: contents.join('\n\n') }],
      source: { kind: 'product-expert-kit-instructions', form: 'instructions', expertKitId: selectionId, names },
    })] }
  })
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
