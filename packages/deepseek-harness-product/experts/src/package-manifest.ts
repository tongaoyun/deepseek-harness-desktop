/** Manifest encoding shared by the expert editor and immutable package storage. */
import { z } from 'zod'

/** Retain imported metadata verbatim until its display summary changes.
 * @param slug - Package identifier used when creating a manifest.
 * @param description - Editable display summary, limited to 160 characters.
 * @param source - Original manifest; omitted for a newly created package.
 * @returns Original JSON when the summary is unchanged, otherwise JSON with the edited description.
 */
export function expertPackageManifest(slug: string, description: string, source?: string): string {
  if (source === undefined) return JSON.stringify({ worker: { suggested_name: slug }, description }, null, 2)
  const document = z.record(z.string(), z.unknown()).parse(JSON.parse(source))
  if (typeof document.description === 'string' && expertDescriptionSummary(document.description) === description.trim()) return source
  return JSON.stringify({ ...document, description }, null, 2)
}

/** Project an AgentSpec description into the editable display summary.
 * @param description - Full manifest description.
 * @returns Trimmed summary accepted by the expert editor.
 */
export function expertDescriptionSummary(description: string): string {
  return description.trim().slice(0, 160).trim()
}
