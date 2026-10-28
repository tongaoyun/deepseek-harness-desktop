/** Shared native Typert Remote artifact generation for product packages. */
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'

export interface RemoteGenerationOptions {
  readonly packageRoot: string
  readonly packageName: string
  readonly tempPrefix: string
  readonly label: string
  readonly remoteName?: string
  readonly references?: readonly string[]
  readonly prepare?: (context: {
    readonly root: string
    readonly packageRoot: string
    readonly output: string
    readonly check: boolean
  }) => Promise<void>
}

/** Generate or verify one package's Host and Client Remote metadata. */
export async function generateRemote(options: RemoteGenerationOptions, check = false): Promise<void> {
  const root = resolve(options.packageRoot, '../../..')
  const output = join(options.packageRoot, 'src/generated')
  const temporary = await mkdtemp(join(tmpdir(), options.tempPrefix))
  try {
    const aggregate = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.host.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')) },
    })
    if (!aggregate) throw new Error('Host aggregate is unavailable')
    const config = join(temporary, 'tsconfig.json')
    await writeFile(config, JSON.stringify({
      extends: join(root, 'tsconfig.base.json'), files: [],
      references: [...(aggregate.projectReferences ?? []).map(item => ({ path: item.path })),
        ...(options.references ?? []).map(path => ({ path })),
        { path: join(options.packageRoot, 'tsconfig.json') }],
    }))
    await options.prepare?.({ root, packageRoot: options.packageRoot, output, check })
    const model = new WorkspaceAnalyzer({ root, hostConfig: config, clientConfig: join(temporary, 'no-client.json'),
      packages: [options.packageName], faces: ['host'], checkDiagnostics: false }).analyze()
    const face = model.faces[0]
    if (!face) throw new Error(`${options.label} Host model is missing`)
    const artifact = new FaceModelEmitter(face).emit(options.packageName)
    if (!artifact.remote) throw new Error(`${options.label} Remote methods are missing`)
    const generated = {
      'typert.host.js': artifact.js,
      'typert.host.d.ts': artifact.dts,
      'typert.remote-client.js': artifact.remote.js,
      'typert.remote-client.d.ts': artifact.remote.dts.replace('\n\nexport declare const TYPERT_REMOTE:',
        `\n/** Native ${options.remoteName ?? options.label.toLowerCase()} management methods generated from the Host service. */\nexport declare const TYPERT_REMOTE:`),
      'typert.remote-client.d.ts.map': artifact.remote.dtsMap,
    }
    await mkdir(output, { recursive: true })
    for (const [name, content] of Object.entries(generated)) {
      const target = join(output, name)
      if (check) {
        if (await readFile(target, 'utf8') !== content) throw new Error(`Stale generated Remote metadata: ${target}`)
      } else await writeFile(target, content)
    }
    console.log(`${options.label} Remote metadata is current`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
