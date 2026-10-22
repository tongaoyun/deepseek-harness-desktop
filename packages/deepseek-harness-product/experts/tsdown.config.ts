import type { UserConfig } from 'tsdown'
import ts from 'typescript'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/** 将标准装饰器降级，避免 Node 直接解析 @Remote 语法；Vitest 同步逻辑见 vitest.config.ts。 */
function standardDecoratorPlugin() {
  return {
    name: 'standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
    },
  }
}


export default ({ env }: { env?: Record<string, unknown> }) => env?.DSH_BUILD_FACE === 'client' ? [] : [{
  entry: { index: 'src/index.ts', remote: 'src/remote.ts', client: 'src/client/index.ts' },
  outDir: 'lib', format: 'esm', platform: 'node',
  plugins: [standardDecoratorPlugin()],
  external: ['react-dom', 'react-dom/client'],
  dts: true, fixedExtension: false, clean: true,
} satisfies UserConfig]
