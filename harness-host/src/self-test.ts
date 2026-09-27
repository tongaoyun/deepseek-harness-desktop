import type { Context } from '@deepseek-ai/cordis'
import { readPrimaryRuntime, workspaceDependencyPaths } from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { createRequire } from 'node:module'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ComputerUseBridge, runComputerUsePreflight } from './local-computer-use-plugin.js'
import { discoverAuthorizedRoots, LocalFileBridge } from './local-files-plugin.js'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)

interface CapabilityCheck {
  key: string
  passed: boolean
  detail: string
}

export async function runLocalCapabilitySelfTest(includeComputer = true): Promise<{ status: 'passed'; checks: CapabilityCheck[] }> {
  const root = await mkdtemp(join(tmpdir(), 'xiaoyin-capability-self-test-'))
  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const [authorizedRoot] = await discoverAuthorizedRoots([root])
    if (!authorizedRoot) throw new Error('Self-test directory authorization failed')
    const bridge = new LocalFileBridge([authorizedRoot])
    await bridge.writeText(authorizedRoot.id, 'local-file.txt', 'xiaoyin local file', false)
    const localFile = await bridge.readText(authorizedRoot.id, 'local-file.txt')
    ensure(localFile.content === 'xiaoyin local file', 'Local file content mismatch')

    const runtimeSource = process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME
    ensure(Boolean(runtimeSource?.trim()), 'Official Primary Runtime is not configured')
    const runtimeRoot = resolve(runtimeSource!)
    const manifest = await readPrimaryRuntime(runtimeRoot)
    ensure(manifest.platform === process.platform && manifest.arch === process.arch, 'Primary Runtime target does not match this host')
    const dependencies = workspaceDependencyPaths(runtimeRoot, manifest)
    await ensureFile(dependencies.python, 'Bundled Python executable is missing')
    await ensureDirectory(dependencies.pythonPackages, 'Bundled Python packages are missing')
    const officeAssets = resolve(runtimeRoot, '..', 'office-skills')
    const officeChecker = join(officeAssets, 'scripts', 'check_office.py')
    await ensureFile(officeChecker, 'Official Office skill assets are missing')
    for (const skill of ['office-docx', 'office-xlsx', 'office-pptx']) {
      await ensureFile(join(officeAssets, skill, 'SKILL.md'), `Official ${skill} skill is missing`)
    }
    const python = await execFileAsync(dependencies.python, ['-I', '-B', '-c', [
      'import docx, openpyxl, pptx, PIL, lxml, pandas, xlsxwriter',
      'print("office-python-ready")',
    ].join(';')], { timeout: 30_000 })
    ensure(python.stdout.includes('office-python-ready'), 'Official Office Python dependencies failed to load')
    const kitManifest = require.resolve('@deepseek-ai/libreoffice-kit/package.json')
    const kitCli = join(dirname(kitManifest), 'lib', 'cli.js')
    const kit = await execFileAsync(process.execPath, [kitCli, 'capabilities', '--json'], { timeout: 30_000 })
    const capabilities: unknown = JSON.parse(kit.stdout)
    ensure(isRecord(capabilities) && Array.isArray(capabilities.conversions), 'LibreOffice Kit returned invalid capabilities')

    const shell = process.platform === 'win32'
      ? await execFileAsync(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output xiaoyin-shell-ready'],
          { cwd: root, timeout: 10_000 },
        )
      : await execFileAsync('/bin/bash', ['--noprofile', '--norc', '-c', 'printf xiaoyin-shell-ready'], { cwd: root, timeout: 10_000 })
    ensure(shell.stdout.includes('xiaoyin-shell-ready'), 'Native Harness shell execution failed')

    const checks: CapabilityCheck[] = [
      { key: 'local-files', passed: true, detail: 'write and read' },
      { key: 'office-runtime', passed: true, detail: `Python ${manifest.python} and pinned Office libraries` },
      { key: 'office-skills', passed: true, detail: 'official DOCX, XLSX and PPTX skills' },
      { key: 'libreoffice-kit', passed: true, detail: 'capability CLI ready' },
      { key: 'native-shell', passed: true, detail: 'Harness subprocess and platform shell ready' },
    ]

    if (includeComputer && process.platform === 'win32') {
      const signal = new AbortController().signal
      const preflight = await runComputerUsePreflight(signal)
      ensure(preflight.screen.width > 0 && preflight.screen.height > 0, 'Windows Computer Use screen discovery failed')
      if (preflight.interactiveDesktop) {
        let capturedBytes = 0
        const context = { attachments: { saveImage: async ({ data }: { data: Buffer }) => {
          capturedBytes = data.length
          return { id: 'self-test-image', mediaType: 'image/png' }
        } } } as unknown as Context
        const observation = await new ComputerUseBridge(context).observe(20, signal)
        ensure(observation.screen.width > 0 && observation.screen.height > 0 && capturedBytes > 0,
          'Windows Computer Use observation failed')
        checks.push({ key: 'computer-use', passed: true, detail: 'desktop screenshot and accessibility observation' })
      } else {
        checks.push({
          key: 'computer-use',
          passed: true,
          detail: `bridge dependencies ready; interactive observation deferred outside Windows session ${preflight.sessionId}`,
        })
      }
    }

    return { status: 'passed', checks }
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await rm(root, { recursive: true, force: true })
  }
}

function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function ensureFile(path: string, message: string): Promise<void> {
  ensure((await stat(path)).isFile(), message)
}

async function ensureDirectory(path: string, message: string): Promise<void> {
  ensure((await stat(path)).isDirectory(), message)
}
