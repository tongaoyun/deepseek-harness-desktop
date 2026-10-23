/** Deterministic lexical ranking for the authorized native MCP tool catalog. */
import { z } from 'zod'

function normalize(text: string): string {
  return text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase()
}

function terms(text: string): Set<string> {
  const normalized = normalize(text)
  return new Set([...(normalized.match(/[a-z0-9]+/gu) ?? []),
    ...(normalized.match(/[\p{Script=Han}]+/gu) ?? []).flatMap(word => word.length === 1 ? [word]
      : Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)))])
}

/** A bounded keyword expression supplied by the model, including translated variants. */
export const connectorSearchQuery = z.string().trim().min(1).max(200).refine(value => terms(value).size > 0)

interface SearchableTool { readonly raw: string; readonly tool: { readonly description: string } }

/** Rank tool names and descriptions; connector names alone cannot load an entire catalog.
 * @param candidates Tools already filtered by live permission, version and MCP availability.
 * @param queries Primary keywords and model-supplied synonyms or translations; no remote inference runs here.
 * @returns Matching candidates, best first; equal scores retain deterministic original-name ordering.
 */
export function rankConnectorTools<T extends SearchableTool>(candidates: readonly T[], queries: readonly string[]): T[] {
  const documents = candidates.map(candidate => ({ candidate, name: terms(candidate.raw), description: terms(candidate.tool.description) }))
  const frequencies = new Map<string, number>()
  for (const document of documents) {
    for (const word of new Set([...document.name, ...document.description])) frequencies.set(word, (frequencies.get(word) ?? 0) + 1)
  }
  const expressions = queries.map(query => ({ text: normalize(query), words: [...terms(query)].map(word => ({
    word, weight: 1 + Math.log(1 + documents.length / (1 + (frequencies.get(word) ?? 0))),
  })) }))
  return documents.flatMap(({ candidate, name, description }) => {
    const score = Math.max(...expressions.map((query) => {
      const total = query.words.reduce((sum, { weight }) => sum + weight, 0)
      const matched = query.words.reduce((sum, { word, weight }) => sum + weight * (name.has(word) ? 3 : description.has(word) ? 1 : 0), 0)
      // A supplied original name must outrank descriptions that merely mention it.
      return (normalize(candidate.raw) === query.text ? 4 : 0) + (total === 0 ? 0 : matched / total)
    }))
    return score > 0 ? [{ candidate, score }] : []
  }).sort((a, b) => b.score - a.score || a.candidate.raw.localeCompare(b.candidate.raw))
    .map(({ candidate }) => candidate)
}
