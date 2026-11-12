/** Collision checks for normalized skill and AgentSpec package paths, usable in Host and Client. */

/** Check explicit entries and their implied directories without relying on filesystem case rules.
 * @param fail Operation-owned failure constructor; every conflict must throw.
 * Paths must be normalized and validated by the caller before checking collisions.
 * @returns Validator for one package, rejecting duplicates, case aliases and file/directory conflicts.
 */
export function createArchivePathValidator(
  fail: (kind: 'duplicate' | 'conflict', path: string) => never,
): (entry: { readonly path: string; readonly directory: boolean }) => void {
  const entries = new Set<string>()
  const nodes = new Map<string, { path: string; directory: boolean }>()
  return (entry): void => {
    const key = entry.path.toLowerCase()
    if (entries.has(key)) fail('duplicate', entry.path)
    entries.add(key)
    const parts = entry.path.split('/')
    for (let index = 1; index <= parts.length; index += 1) {
      const path = parts.slice(0, index).join('/')
      const directory = index < parts.length || entry.directory
      const previous = nodes.get(path.toLowerCase())
      if (previous && (previous.path !== path || previous.directory !== directory)) fail('conflict', path)
      nodes.set(path.toLowerCase(), { path, directory })
    }
  }
}
