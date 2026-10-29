/** Convert compiler-owned absolute type imports into portable source imports.
 * @param text TypeScript's fully qualified inferred result type.
 * @param packageRoot Native absolute path to the skills package.
 * @returns Type syntax referring to the package's source files.
 */
export function skillResultType(text: string, packageRoot: string): string {
  const prefix = packageRoot.replaceAll('\\', '/').replace(/\/$/u, '') + '/src/'
  return text.replaceAll(prefix, '../')
    .replaceAll(', { with: { "resolution-mode": "import" } }', '')
    .replace(/import\("(\.\.\/[^" ]+)"\)/gu, (_match, path: string) => `import("${path}.ts")`)
}
