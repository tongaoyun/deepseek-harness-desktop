/** Generate source-plane Remote metadata from the actual Host methods with the native Typert compiler. */
import { generateRemote } from '../../experts/scripts/generate-remote-shared.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/** Generate or verify this package's source-plane contracts.
 * @param check Reject stale generated files instead of rewriting them.
 */
export async function generateSkillRemote(check = false): Promise<void> {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  await generateRemote({ packageRoot, packageName: '@deepseek-harness/product-skills', tempPrefix: 'skills-typert-', label: 'Skills', remoteName: 'skill', prepare: async ({ output, check }) => {
    // Materialize inferred operation results first: the native analyzer requires explicit type syntax.
    // These types are regenerated from implementations, never maintained as a second DTO set.
    const inference = join(packageRoot, 'scripts/result-inference.ts')
    const parsed = ts.getParsedCommandLineOfConfigFile(join(packageRoot, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) } })
    if (!parsed) throw new Error('Skills compiler configuration is unavailable')
    const program = ts.createProgram([...parsed.fileNames, inference], parsed.options)
    const checker = program.getTypeChecker()
    const source = program.getSourceFile(inference)
    const declaration = source?.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'SkillManagerResults')
    if (!declaration) throw new Error('Skill result inference is unavailable')
    let results = '/** Generated from owning operation results by scripts/generate-remote.ts. Do not edit. */\nexport interface SkillManagerResults {\n'
    for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(declaration))) {
      const type = checker.getTypeOfSymbolAtLocation(property, declaration)
      let text = checker.typeToString(type, undefined,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.InTypeAlias)
      const prefix = packageRoot.replace(/\/$/u, '') + '/src/'
      text = text.replaceAll(prefix, '../').replaceAll(', { with: { "resolution-mode": "import" } }', '')
      text = text.replace(/import\("(\.\.\/[^" ]+)"\)/gu, (_match, path: string) => `import("${path}.ts")`)
      results += `  ${property.name}: ${text};\n`
    }
    results += '}\n'
    await mkdir(output, { recursive: true })
    const resultPath = join(output, 'results.ts')
    if (check) {
      if (await readFile(resultPath, 'utf8') !== results) throw new Error('Stale generated skill results')
    } else await writeFile(resultPath, results)
  } }, check)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateSkillRemote(process.argv.includes('--check'))
