/** AgentSpec content packages consumed by the product's native expert adapter. */
import { z } from 'zod'

/** AgentSpec metadata; additional upstream fields remain intact during round trips. */
export const agentSpecManifestSchema = z.looseObject({
  worker: z.looseObject({ suggested_name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(80) }),
  description: z.string().trim().min(1).max(2000),
  tags: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
})

/** Parsed upstream manifest. */
export type AgentSpecManifest = z.infer<typeof agentSpecManifestSchema>

/** Decode a bounded manifest without interpreting runtime installation declarations.
 * @param text - UTF-8 manifest.json contents.
 * @returns Validated upstream metadata.
 */
export function agentSpecManifest(text: string): AgentSpecManifest {
  if (Buffer.byteLength(text, 'utf8') > 128 * 1024 || text.includes('\0')) throw new Error('AgentSpec manifest.json 无效')
  return agentSpecManifestSchema.parse(JSON.parse(text))
}

/** Compose literal expert instructions and the immutable resource location.
 * @param soul - Expert identity and responsibilities.
 * @param agents - Optional working rules.
 * @param resourceRoot - Host-local package directory used by native file tools.
 * @returns Instructions for the native subagent or teammate.
 */
export function agentSpecPrompt(soul: string, agents: string, resourceRoot: string): string {
  if (!soul.trim() || [soul, agents].some(value => value.includes('\0') || Buffer.byteLength(value, 'utf8') > 128 * 1024)) {
    throw new Error('专家说明无效，config/SOUL.md 不能为空')
  }
  return [soul, agents, `Expert package resource directory: ${resourceRoot}\nResolve package-relative references against this directory. Read resources with the native file tools when needed. Package metadata does not grant permissions or change the selected knowledge scope.`].filter(Boolean).join('\n\n')
}
