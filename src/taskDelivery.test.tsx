import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LocalFileBridge, discoverAuthorizedRoots } from '../harness-host/src/local-files-plugin'
import { applyHarnessNotification, createTaskMonitor } from './harness'
import { TaskArtifacts } from './TaskArtifacts'

it('delivers a real external output, refreshes it after a follow-up and never invents a file change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-delivery-test-'))
  try {
    const bridge = new LocalFileBridge(await discoverAuthorizedRoots([{ id: 'workspace', name: '工作目录', path: directory }]))
    // Simulate an external producer (code/Shell/application), not an Office tool.
    await writeFile(join(directory, 'report.csv'), 'product,total\nA,12\n')
    let monitor = createTaskMonitor()
    for (const [index, content] of ['product,total\nA,12\n', 'product,total\nA,12\n总计,12\n'].entries()) {
      await writeFile(join(directory, 'report.csv'), content)
      const result = await bridge.publish('workspace', 'report.csv')
      const callId = `publish-${index}`
      monitor = applyHarnessNotification(monitor, event('tool/call', { callId, name: 'local_files_publish', arguments: { path: 'report.csv' } }))
      monitor = applyHarnessNotification(monitor, event('tool/result', { message: { content: [{
        type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(result) }],
      }] } }))
      expect(monitor.artifacts).toHaveLength(1)
      expect(monitor.artifacts[0]).toMatchObject({ rootId: 'workspace', path: 'report.csv', kind: 'spreadsheet', action: 'published', sizeBytes: Buffer.byteLength(content) })
      expect(monitor.changes ?? []).toEqual([])
      expect(await readFile(join(directory, 'report.csv'), 'utf8')).toBe(content)
    }
    const html = renderToStaticMarkup(<TaskArtifacts conversation artifacts={monitor.artifacts} onOpen={() => {}} />)
    expect(html).toContain('交付了 1 个文件')
    expect(html).toContain('已就绪')
    expect(html).toContain('report.csv')
    expect(html).not.toContain('已创建')
    monitor = applyHarnessNotification(monitor, event('tool/call', { callId: 'missing', name: 'local_files_publish' }))
    monitor = applyHarnessNotification(monitor, event('tool/result', { message: { content: [{
      type: 'tool-result', toolCallId: 'missing', isError: true, content: [{ type: 'text', text: '文件不存在' }],
    }] } }))
    expect(monitor.artifacts).toHaveLength(1)
    expect(monitor.timeline?.find((item) => item.toolName === 'local_files_publish')?.kind).toBe('file')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function event(type: string, data: Record<string, unknown>) {
  return { taskId: 'task-delivery', requestId: 1, event: { event: { method: 'session.event', params: { event: { type, time: Date.now(), data } } } } }
}

it('shows converted and recalculated copies as separate real deliverables, never as edits to their source', () => {
  let monitor = createTaskMonitor()
  for (const [tool, source, output] of [['office_document_export_pdf', 'report.docx', 'report-review.pdf'], ['office_xlsx_recalculate', 'report.xlsx', 'report-calculated.xlsx']]) {
    monitor = applyHarnessNotification(monitor, event('tool/call', { callId: tool, name: tool, arguments: { rootId: 'work', path: source, outputPath: output } }))
    monitor = applyHarnessNotification(monitor, event('tool/result', { message: { content: [{ type: 'tool-result', toolCallId: tool, content: [{ type: 'text', text: JSON.stringify({ rootId: 'work', rootName: '工作目录', path: output, size: 200, afterHash: 'a'.repeat(64), originalUnchanged: true }) }] }] } }))
  }
  expect(monitor.artifacts.map((artifact) => artifact.path)).toEqual(['report-review.pdf', 'report-calculated.xlsx'])
  expect(monitor.changes?.map((change) => [change.path, change.action])).toEqual([['report-review.pdf', 'created'], ['report-calculated.xlsx', 'created']])
})
