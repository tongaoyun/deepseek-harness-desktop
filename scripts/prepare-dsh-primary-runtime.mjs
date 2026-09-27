import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The carrier is an official DeepSeek Harness build input. Fetch the pinned
// upstream files at build time instead of copying their source into Xiaoyin.
const officialCommit = '477b4f420553e8a52c2fbccc464d7561b239c443'
const officialBaseUrl = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${officialCommit}`
const sourceMirror = process.env.XIAOYIN_PRIMARY_RUNTIME_SOURCE_MIRROR?.trim()
const upstreamFiles = {
  'scripts/primary-runtime/prepare.ts': '510f2ac2579ee348a98760faddee5e13e65b8bd0b759ce10f25d8cf74febd306',
  'scripts/primary-runtime/lock.json': '733c3c53d95ae524bddb123e1319c48ecacb0dc729be956c25188f930c095bd5',
  'scripts/primary-runtime/smoke.py': '234988569fefbfdf06b53e98f12d825c1d1de26dcbecc10058aec1ffddc8fdd8',
}

const values = parseArguments(process.argv.slice(2))
const staging = await mkdtemp(join(repository, 'scripts', '.primary-runtime-'))
try {
  for (const [sourcePath, sha256] of Object.entries(upstreamFiles)) {
    const sourceName = sourcePath.split('/').pop()
    if (!sourceName) throw new Error(`Invalid official source path: ${sourcePath}`)
    const sourceUrl = sourceMirror ? `${sourceMirror}/${encodeURIComponent(sourceName)}` : `${officialBaseUrl}/${sourcePath}`
    const response = await fetchWithRetry(sourceUrl)
    if (!response.ok) throw new Error(`Official Primary Runtime source download failed: ${response.status} ${sourcePath}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== sha256) throw new Error(`Official ${sourcePath} SHA-256 mismatch`)
    const name = sourceName
    let content = bytes.toString('utf8')
    if (name === 'prepare.ts') {
      content = adaptOfficialCarrierSource(content)
    }
    await writeFile(join(staging, name), content)
  }
  await execFileAsync(process.execPath, [
    '--import', 'tsx', join(staging, 'prepare.ts'),
    '--target', values.target,
    '--output', values.output,
    '--cache', values.cache,
    '--python-only',
  ], { cwd: repository, stdio: 'inherit', timeout: 30 * 60_000 })
} finally {
  await rm(staging, { recursive: true, force: true })
}

async function fetchWithRetry(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (response.ok || attempt === 3) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
      if (attempt === 3) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
  }
  throw lastError ?? new Error('Official Primary Runtime source download failed')
}

function adaptOfficialCarrierSource(source) {
  const dependencyImport = '../../packages/skill/tool-workspace-dependencies/src/index.ts'
  if (!source.includes(dependencyImport)) throw new Error('Official Primary Runtime dependency import changed')
  const versionRead = "const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }"
  if (!source.includes(versionRead)) throw new Error('Official Primary Runtime carrier version source changed')
  const pythonDownload = "return downloadPrimaryRuntimeAsset(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(filename)}`, artifact.pythonSha256, cache)"
  if (!source.includes(pythonDownload)) throw new Error('Official Primary Runtime Python download source changed')
  const wheelDownload = "await downloadPrimaryRuntimeAsset(wheel.url, wheel.sha256, paths.downloads)"
  if (!source.includes(wheelDownload)) throw new Error('Official Primary Runtime wheel download source changed')
  return source
    .replace(dependencyImport, '@deepseek-ai/dsh-tool-workspace-dependencies')
    .replace(versionRead, "const version = '0.1.7-rc.2'")
    .replace(pythonDownload, "return downloadPrimaryRuntimeAsset(`${process.env.XIAOYIN_PRIMARY_RUNTIME_MIRROR ? `${process.env.XIAOYIN_PRIMARY_RUNTIME_MIRROR}/${lock.pythonRelease}` : `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}`}/${encodeURIComponent(filename)}`, artifact.pythonSha256, cache)")
    .replace(wheelDownload, "await downloadPrimaryRuntimeAsset(primaryRuntimeAssetUrl(wheel.url), wheel.sha256, paths.downloads)")
    .replace("export function primaryRuntimePayloadDigest(", "function primaryRuntimeAssetUrl(url: string): string {\n  const mirror = process.env.XIAOYIN_PRIMARY_RUNTIME_MIRROR\n  if (!mirror) return url\n  const filename = new URL(url).pathname.split('/').pop()\n  if (!filename) throw new Error(`Invalid primary runtime asset URL: ${url}`)\n  return `${mirror}/${lock.pythonRelease}/${encodeURIComponent(filename)}`\n}\n\nexport function primaryRuntimePayloadDigest(")
}

function parseArguments(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!['--target', '--output', '--cache'].includes(key) || !value) {
      throw new Error('Usage: prepare-dsh-primary-runtime.mjs --target <target> --output <directory> --cache <directory>')
    }
    parsed[key.slice(2)] = key === '--target' ? value : resolve(value)
  }
  if (!['win-x64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'].includes(parsed.target)
    || !parsed.output || !parsed.cache) {
    throw new Error('A supported target, output and cache are required')
  }
  return parsed
}
