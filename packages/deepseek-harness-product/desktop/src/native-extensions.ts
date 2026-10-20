/** Preinstalled plugins use the official profile and retain employee-owned configuration. */
import { composeEntries, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const plugins = [
  { id: 'agency-agents-remote', packageName: '@michengai/dsh-agency-agents/remote' },
  { id: 'agency-agents', packageName: '@michengai/dsh-agency-agents' },
  { id: 'skills-manager', packageName: '@michengai/dsh-skills-manager' },
] as const

/** Add missing plugins, preserving existing configuration and disabled state.
 * @param profile - Official profile directory and application installation anchor.
 * @returns Profile patches for plugins not already present under any entry ID.
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
  const insert = plugins.flatMap(({ id, packageName }) => {
    const name = import.meta.resolve(packageName)
    const matches = (entry: typeof entries[number]) => entry.name === packageName || entry.name === name
    if (flattened.some(entry => entry.id === id && !matches(entry))) {
      throw new Error(`Preinstalled plugin entry is occupied: ${id}`)
    }
    const existing = flattened.filter(matches)
    if (existing.length > 1) throw new Error(`Duplicate preinstalled plugin: ${packageName}`)
    return existing.length === 1 ? [] : [{ id, name }]
  })
  return insert.length === 0 ? [] : [{ insert }]
}
