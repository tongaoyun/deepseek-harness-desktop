/** Preinstalled plugins use the official profile and retain employee-owned configuration. */
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const plugins = [
  { id: 'product-mcp-storage', packageName: '@deepseek-harness/product-runtime/native-mcp-storage' },
  { id: 'mcp-connector', packageName: 'dsh-mcp-connector' },
  { id: 'agency-agents-remote', packageName: '@michengai/dsh-agency-agents/remote' },
  { id: 'agency-agents', packageName: '@michengai/dsh-agency-agents' },
  { id: 'skills-manager', packageName: '@michengai/dsh-skills-manager' },
] as const

/** Select bundled plugin code, preserving existing configuration and disabled state.
 * @param profile - Official profile directory and application installation anchor.
 * @returns Profile patches that replace existing plugin specifiers or insert missing plugins.
 */
export function nativeExtensionPatches(profile: { readonly directory: string; readonly installAnchor: string }) {
  const loaded = loadProfileDirectory('dsh', profile.directory, profile.installAnchor)
  const entries = composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches])
  const flattened: typeof entries = []
  const inspect = (rows: typeof entries) => {
    for (const row of rows) {
      flattened.push(row)
      if (row.group && Array.isArray(row.config)) inspect(row.config as typeof entries)
    }
  }
  inspect(entries)
  const replacements: { id: string; name: string; replace: string }[] = []
  const insert = plugins.flatMap(({ id, packageName }) => {
    const name = import.meta.resolve(packageName)
    const matches = (entry: typeof entries[number]) => entry.name === packageName || entry.name === name
    if (flattened.some(entry => entry.id === id && !matches(entry))) {
      throw new Error(`Preinstalled plugin entry is occupied: ${id}`)
    }
    const existing = flattened.filter(matches)
    if (existing.length > 1) throw new Error(`Duplicate preinstalled plugin: ${packageName}`)
    const entry = existing[0]
    if (entry) {
      if (entry.name !== name) {
        if (!entry.id || !entry.name) throw new Error(`Preinstalled plugin has no entry ID or name: ${packageName}`)
        replacements.push({ id: entry.id, name: entry.name, replace: name })
      }
      return []
    }
    replacements.push({ id, name: packageName, replace: name })
    return [{ id, name: packageName }]
  })
  return [...(insert.length === 0 ? [] : [{ insert, defaults: true }]), ...replacements]
}
