import type { Context } from '@deepseek-ai/cordis'
import { Document, Packer, Paragraph } from 'docx'
import ExcelJS from 'exceljs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { ComputerUseBridge, runComputerUsePreflight } from './local-computer-use-plugin.js'
import { parseDocx, parsePdf, parseXlsx, renderPdf, selectPdfFont } from './local-documents-plugin.js'
import { discoverAuthorizedRoots, LocalFileBridge } from './local-files-plugin.js'

const { Workbook } = ExcelJS
const execFileAsync = promisify(execFile)

interface CapabilityCheck {
  key: string
  passed: boolean
  detail: string
}

export async function runLocalCapabilitySelfTest(): Promise<{ status: 'passed'; checks: CapabilityCheck[] }> {
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

    const docxBytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('xiaoyin docx')] }] }))
    await writeFile(join(root, 'self-test.docx'), docxBytes)
    ensure(JSON.stringify(await parseDocx(docxBytes)).includes('xiaoyin docx'), 'DOCX round trip failed')

    const workbook = new Workbook()
    workbook.addWorksheet('Acceptance').addRows([['capability', 'status'], ['xlsx', 'ready']])
    const xlsxBytes = Buffer.from(await workbook.xlsx.writeBuffer())
    await writeFile(join(root, 'self-test.xlsx'), xlsxBytes)
    ensure(JSON.stringify(await parseXlsx(xlsxBytes)).includes('ready'), 'XLSX round trip failed')

    const pdfBytes = await renderPdf('Xiaoyin acceptance', ['PDF ready'], await selectPdfFont('PDF ready'))
    await writeFile(join(root, 'self-test.pdf'), pdfBytes)
    ensure(JSON.stringify(await parsePdf(pdfBytes)).includes('PDF ready'), 'PDF round trip failed')

    const shell = process.platform === 'win32'
      ? await execFileAsync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output xiaoyin-shell-ready'], { cwd: root, timeout: 10_000 })
      : await execFileAsync('/bin/bash', ['--noprofile', '--norc', '-c', 'printf xiaoyin-shell-ready'], { cwd: root, timeout: 10_000 })
    ensure(shell.stdout.includes('xiaoyin-shell-ready'), 'Native Harness shell execution failed')

    const checks: CapabilityCheck[] = [
      { key: 'local-files', passed: true, detail: 'write and read' },
      { key: 'office-docx', passed: true, detail: 'create and parse' },
      { key: 'office-xlsx', passed: true, detail: 'create and parse' },
      { key: 'office-pdf', passed: true, detail: 'create and parse' },
      { key: 'native-shell', passed: true, detail: 'Harness subprocess and platform shell ready' },
    ]

    if (process.platform === 'win32') {
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

    for (const file of ['self-test.docx', 'self-test.xlsx', 'self-test.pdf']) {
      ensure((await readFile(join(root, file))).length > 0, `${file} is empty`)
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
