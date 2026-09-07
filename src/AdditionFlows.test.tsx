// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, expect, it, vi } from 'vitest'
import { McpConnectorDialog, splitMcpCommand } from './McpConnectorDialog'
import { ExtensionUploadDialog } from './ExtensionUploadDialog'
import { selectDeveloperExtension } from './expertKits'
import { parseConnectorJson } from './connectorImport'
import { buildRuntimeConnectorCatalog } from './connectors'

vi.mock('./expertKits', () => ({ selectDeveloperExtension: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
beforeEach(() => vi.resetAllMocks())
async function fixture(view: ReactNode, check: (container: HTMLDivElement) => Promise<void>) {
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try { await act(async () => root.render(view)); await check(container) }
  finally { await act(async () => root.unmount()); container.remove() }
}
async function click(container: HTMLElement, selector: string) { await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click()) }
async function submit(container: HTMLElement) { await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))) }
async function fill(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('tokenizes full commands without evaluating shell expressions and preserves quoted paths', () => {
  expect(splitMcpCommand('node "/Users/test/My Work/server.js" --key \'two words\' ""')).toEqual(['node', '/Users/test/My Work/server.js', '--key', 'two words', ''])
  expect(splitMcpCommand('node $(whoami)')).toEqual(['node', '$(whoami)'])
  expect(splitMcpCommand('"C:\\Apps\\node.exe" script.js')).toEqual(['C:\\Apps\\node.exe', 'script.js'])
  expect(() => splitMcpCommand('node "bad')).toThrow('引号未闭合')
  expect(() => splitMcpCommand(' ')).toThrow('启动命令')
})

it('keeps a failed MCP form for retry and forwards the actual timeout to the runtime', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('存储失败')).mockResolvedValueOnce(undefined); const close = vi.fn()
  await fixture(<McpConnectorDialog existingIds={[]} onSave={save} onClose={close} />, async (container) => {
    await fill(container, 'input[placeholder="my-mcp-server"]', 'test-server')
    await fill(container, 'textarea', 'node "my server.js"')
    await fill(container, 'input[type="number"]', '120')
    await submit(container)
    expect(close).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('存储失败')
    expect(container.querySelector('textarea')!.value).toBe('node "my server.js"')
    await submit(container)
    expect(close).toHaveBeenCalledOnce()
    const saved = save.mock.calls[1][0]
    expect(saved).toMatchObject({ command: 'node', arguments: ['my server.js'], timeoutSeconds: 120 })
    expect(buildRuntimeConnectorCatalog([saved], '', ['test-server'])[0].timeoutSeconds).toBe(120)
  })
})

it('rejects duplicate MCP names before writing', async () => {
  const save = vi.fn()
  await fixture(<McpConnectorDialog existingIds={['test-server']} onSave={save} onClose={vi.fn()} />, async (container) => {
    await fill(container, 'input[placeholder="my-mcp-server"]', 'test-server')
    await fill(container, 'textarea', 'node server.js')
    await submit(container)
    expect(save).not.toHaveBeenCalled()
    expect(container.textContent).toContain('该连接器已存在')
  })
})

it('validates timeout values in JSON imports', () => {
  for (const timeoutSeconds of [0, 601, 1.5, '60']) expect(() => parseConnectorJson(JSON.stringify({ name: 'test', command: 'node', timeoutSeconds }))).toThrow('1–600')
  expect(parseConnectorJson('{"name":"test","command":"node","timeoutSeconds":600}').timeoutSeconds).toBe(600)
})

it('selects a skill without installing and installs only after confirmation, retaining failures for retry', async () => {
  vi.mocked(selectDeveloperExtension).mockResolvedValue('/tmp/test/SKILL.md')
  const install = vi.fn().mockRejectedValueOnce(new Error('包结构无效')).mockResolvedValueOnce(undefined), close = vi.fn()
  await fixture(<ExtensionUploadDialog kind="skill" onInstall={install} onClose={close} />, async (container) => {
    expect(container.querySelector<HTMLButtonElement>('footer button')!.disabled).toBe(true)
    await click(container, '.extension-dropzone')
    expect(selectDeveloperExtension).toHaveBeenCalledWith('skill', 'archive')
    expect(install).not.toHaveBeenCalled()
    expect(container.textContent).toContain('SKILL.md')
    await click(container, 'footer button')
    expect(close).not.toHaveBeenCalled()
    expect(container.textContent).toContain('包结构无效')
    await click(container, 'footer button')
    expect(install).toHaveBeenLastCalledWith('/tmp/test/SKILL.md')
    expect(close).toHaveBeenCalledOnce()
  })
})

it('keeps folder selection in the kit upload dialog and cancellation writes nothing', async () => {
  vi.mocked(selectDeveloperExtension).mockResolvedValue(null)
  const install = vi.fn(), close = vi.fn()
  await fixture(<ExtensionUploadDialog kind="expert-kit" onInstall={install} onClose={close} />, async (container) => {
    await click(container, '.upload-folder-button')
    expect(selectDeveloperExtension).toHaveBeenCalledWith('expert-kit', 'directory')
    expect(container.querySelector<HTMLButtonElement>('footer button')!.disabled).toBe(true)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(close).toHaveBeenCalledOnce()
    expect(install).not.toHaveBeenCalled()
  })
})
