/** Convert discovered package manifests into portable bundler workspace patterns. */
import { posix, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

/**
 * Keep filesystem separators from becoming escapes in workspace globs.
 * @param manifests - Repository-relative manifest paths returned by filesystem discovery.
 * @param root - Optional workspace root; excludes packages explicitly declaring `dsh.build: false`.
 * @returns Package directory patterns using forward slashes on every host.
 */
export function workspacePackageGlobs(manifests: readonly string[], root?: string): string[] {
  return manifests.map(path => path.replaceAll('\\', '/'))
    .filter(path => root === undefined || JSON.parse(readFileSync(resolve(root, path), 'utf8')).dsh?.build !== false)
    .map(path => posix.dirname(path))
}
