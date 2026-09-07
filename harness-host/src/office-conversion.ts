import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, posix, win32 } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const MAX_BYTES = 25 * 1024 * 1024
export interface OfficeEngine { available: boolean; executable?: string; reason?: string }
export function officeEngineCandidates(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const paths = platform === 'win32' ? win32 : posix
  const configured = environment.XIAOYIN_SOFFICE_PATH?.trim()
  const candidates = configured ? [configured] : [
    ...(platform === 'darwin' ? [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      paths.join(environment.HOME || homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
    ] : []),
    ...(platform === 'win32' ? [environment.ProgramFiles || 'C:\\Program Files', environment['ProgramFiles(x86)']]
      .filter((path): path is string => Boolean(path))
      .map((path) => paths.join(path, 'LibreOffice', 'program', 'soffice.com')) : []),
    ...(environment.PATH ?? '').split(paths.delimiter).filter((path) => paths.isAbsolute(path)).map((path) => paths.join(path, platform === 'win32' ? 'soffice.com' : 'soffice')),
  ]
  return [...new Set(candidates.filter((path) => paths.isAbsolute(path)))]
}
export async function findOfficeEngine(environment: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<OfficeEngine> {
  for (const executable of officeEngineCandidates(environment, platform)) {
    try { await access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK); if ((await stat(executable)).isFile()) return { available: true, executable } } catch { /* Try the next explicit executable. */ }
  }
  return { available: false, reason: environment.XIAOYIN_SOFFICE_PATH?.trim() ? '指定的 LibreOffice 转换程序不可用，请检查 XIAOYIN_SOFFICE_PATH；普通文档和表格生成不受影响' : '未发现 LibreOffice，暂不能重算公式或将 Office 导出 PDF；普通文档和表格生成不受影响。请安装官方 LibreOffice 后重新检测，或配置 XIAOYIN_SOFFICE_PATH 并重新打开小胤' }
}

export type OfficeRunner = (executable: string, args: string[], signal: AbortSignal, environment?: NodeJS.ProcessEnv) => Promise<void>
export async function convertOffice(bytes: Buffer, extension: string, mode: 'pdf' | 'recalculate', signal: AbortSignal, options: { executable?: string; runner?: OfficeRunner } = {}): Promise<Buffer> {
  signal.throwIfAborted()
  if (bytes.length > MAX_BYTES) throw new Error('Office 文件超过 25 MiB 上限')
  if (!['.docx', '.xlsx', '.pptx'].includes(extension) || mode === 'recalculate' && extension !== '.xlsx') throw new Error('仅支持 DOCX/XLSX/PPTX 转 PDF，以及 XLSX 公式重算')
  // Conversion should not refresh external data or execute embedded macros.
  // Reject such packages instead of silently returning cached external values.
  unzipSync(bytes, { filter(file) {
    if (/vbaproject\.bin$|^xl\/externalLinks\//iu.test(file.name)) throw new Error('含宏或外部工作簿链接的文件需在办公应用中人工处理，不自动转换或刷新外部数据')
    return false
  } })
  const engine = options.executable ? { available: true, executable: options.executable } : await findOfficeEngine()
  if (!engine.executable) throw new Error(engine.reason)
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-office-convert-'))
  try {
    const profile = join(directory, 'profile'), output = join(directory, 'output')
    await mkdir(join(profile, 'user'), { recursive: true }); await mkdir(output)
    // Force a hard recalculation when OOXML is loaded. Never use the user's
    // interactive LibreOffice profile or attach to their running application.
    await writeFile(join(profile, 'user', 'registrymodifications.xcu'), OFFICE_PROFILE)
    const source = join(directory, `source${extension}`)
    await writeFile(source, bytes, { flag: 'wx' })
    const environment = { ...process.env }
    // macOS headless builds may not discover CoreText fonts. Use a private
    // Fontconfig file rather than modifying global settings or the document.
    if (process.platform === 'darwin' && !environment.FONTCONFIG_FILE) {
      const config = join(directory, 'fonts.conf')
      await writeFile(config, officeFontConfig(environment.HOME || homedir(), join(directory, 'font-cache')))
      environment.FONTCONFIG_FILE = config
    }
    const format = mode === 'pdf' ? `pdf:${extension === '.docx' ? 'writer' : extension === '.xlsx' ? 'calc' : 'impress'}_pdf_Export` : 'xlsx:Calc MS Excel 2007 XML'
    const runner: OfficeRunner = options.runner ?? ((executable, args, signal, environment) => runOffice(executable, args, signal, 90_000, environment))
    await runner(engine.executable, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--norestore', '--convert-to', format, '--outdir', output, source], signal, environment)
    signal.throwIfAborted()
    const generated = join(output, mode === 'pdf' ? 'source.pdf' : 'source.xlsx')
    let size: number
    try { size = (await stat(generated)).size } catch { throw new Error('转换程序没有生成结果；文件可能受密码保护、格式不支持或已损坏，原文件未修改') }
    if (!size || size > MAX_BYTES) throw new Error('转换结果为空或超过 25 MiB，未交付半成品')
    const result = await readFile(generated)
    signal.throwIfAborted()
    if (mode === 'pdf' && result.subarray(0, 5).toString() !== '%PDF-') throw new Error('转换程序未返回有效 PDF')
    return result
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export const OFFICE_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
</oor:items>`

export function officeFontConfig(userDirectory: string, cacheDirectory: string): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<fontconfig>
<dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><dir>${escape(posix.join(userDirectory, 'Library/Fonts'))}</dir>
<cachedir>${escape(cacheDirectory)}</cachedir>
</fontconfig>`
}

export function runOffice(executable: string, args: string[], signal: AbortSignal, timeoutMs = 90_000, environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    let failure: Error | undefined, outputSize = 0
    const stop = (reason: Error) => {
      failure ??= reason
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const aborted = () => stop(new Error('Office 转换已停止，原文件未修改'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    const timer = setTimeout(() => stop(new Error('Office 转换超时，未交付结果，原文件未修改')), timeoutMs)
    const collect = (chunk: Buffer) => { outputSize += chunk.length; if (outputSize > 1024 * 1024) stop(new Error('Office 转换输出异常，已停止')) }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
    child.once('error', (error) => { cleanup(); reject(error) })
    child.once('close', (code) => {
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Office 转换程序退出（${code}），原文件未修改`))
      else resolve()
    })
  })
}
