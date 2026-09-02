import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const name = 'xiaoyin-local-browser'
export const inject = ['tools', 'attachments']

const MAX_OUTPUT_CHARS = 30_000
const MAX_SELECTOR_CHARS = 1_000
const MAX_INPUT_CHARS = 20_000

export interface Config { enabled?: boolean; executable?: string }
export const Config = z.object({ enabled: z.boolean().default(true), executable: z.string().default('') })

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled === false) return
  const bridge = new BrowserBridge(ctx, config.executable)
  const unregister = browserTools(bridge).map((definition) => ctx.tools.register(definition))
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (!['browser_click', 'browser_type'].includes(exec.name)) return next()
    return Promise.resolve({ kind: 'ask' as const, reason: browserApprovalReason(exec.name, exec.arguments) })
  })
  ctx.effect(() => async () => {
    stopApprovalPolicy()
    for (const dispose of unregister.reverse()) dispose()
    await bridge.close()
  }, 'xiaoyin local browser connector')
}

export class BrowserBridge {
  private child: ChildProcess | undefined
  private port: number | undefined
  private connection: CdpConnection | undefined
  private readonly profileDirectory: string

  constructor(private readonly ctx: Context, private readonly configuredExecutable = '') {
    this.profileDirectory = resolve(process.env.DSH_HOME ?? process.cwd(), 'browser-profile')
  }

  async open(url: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const validated = validateBrowserUrl(url)
    await this.ensureBrowser(signal)
    await this.openPage(validated, signal)
    return this.snapshot(signal)
  }

  async snapshot(signal: AbortSignal): Promise<BrowserSnapshot> {
    const connection = await this.ensurePage(signal)
    const result = await connection.request('Runtime.evaluate', {
      expression: SNAPSHOT_SCRIPT,
      returnByValue: true,
      awaitPromise: true,
    }, signal)
    const value = record(record(record(result).result).value)
    return normalizeSnapshot(value)
  }

  async click(selector: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const value = validateSelector(selector)
    const result = await (await this.ensurePage(signal)).request('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(value)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true })()`,
      returnByValue: true,
    }, signal)
    if (record(record(result).result).value !== true) throw new Error(`Browser element not found: ${value}`)
    await settle(signal)
    return this.snapshot(signal)
  }

  async type(selector: string, text: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const value = validateSelector(selector)
    if (!text || text.length > MAX_INPUT_CHARS) throw new Error('Browser input text is invalid')
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(value)}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true })()`
    const result = await (await this.ensurePage(signal)).request('Runtime.evaluate', { expression, returnByValue: true }, signal)
    if (record(record(result).result).value !== true) throw new Error(`Browser element not found: ${value}`)
    return this.snapshot(signal)
  }

  async screenshot(signal: AbortSignal): Promise<{ snapshot: BrowserSnapshot; image: ImageAttachmentRef }> {
    const result = await (await this.ensurePage(signal)).request('Page.captureScreenshot', { format: 'png' }, signal)
    const data = record(result).data
    if (typeof data !== 'string' || !data) throw new Error('Browser did not return a screenshot')
    const image = await this.ctx.attachments.saveImage({ data: Buffer.from(data, 'base64'), mediaType: 'image/png', name: 'browser-page.png' })
    return { snapshot: await this.snapshot(signal), image }
  }

  async close(): Promise<void> {
    this.connection?.close()
    this.connection = undefined
    this.child?.kill()
    this.child = undefined
    this.port = undefined
  }

  private async ensureBrowser(signal: AbortSignal): Promise<void> {
    if (this.child && this.port) return
    const executable = await browserExecutable(this.configuredExecutable)
    await mkdir(this.profileDirectory, { recursive: true })
    this.child = spawn(executable, [
      '--remote-debugging-port=0', `--user-data-dir=${this.profileDirectory}`,
      '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { windowsHide: false, stdio: 'ignore' })
    const activePort = resolve(this.profileDirectory, 'DevToolsActivePort')
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (signal.aborted) throw new Error('Browser operation was cancelled')
      try {
        const [line] = (await readFile(activePort, 'utf8')).split(/\r?\n/)
        const port = Number(line)
        if (Number.isSafeInteger(port) && port > 0) { this.port = port; return }
      } catch { /* browser is still starting */ }
      await delay(100)
    }
    throw new Error('Browser debugging endpoint did not start')
  }

  private async openPage(url: string, signal: AbortSignal): Promise<void> {
    this.connection?.close()
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal })
    if (!response.ok) throw new Error(`Browser could not open the page: HTTP ${response.status}`)
    const target = record(await response.json())
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('Browser page endpoint is unavailable')
    this.connection = await CdpConnection.connect(target.webSocketDebuggerUrl, signal)
    await this.connection.request('Page.enable', {}, signal)
    await this.connection.request('Runtime.enable', {}, signal)
    await settle(signal)
  }

  private async ensurePage(signal: AbortSignal): Promise<CdpConnection> {
    await this.ensureBrowser(signal)
    if (!this.connection) await this.openPage('about:blank', signal)
    return this.connection!
  }
}

interface BrowserSnapshot { title: string; url: string; text: string; links: Array<{ text: string; href: string; selector: string }>; controls: Array<{ tag: string; label: string; selector: string }> }

class CdpConnection {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = record(JSON.parse(String(event.data)))
      if (typeof message.id !== 'number') return
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(String(record(message.error).message ?? 'Browser protocol error')))
      else waiter.resolve(message.result)
    })
    socket.addEventListener('close', () => this.rejectPending(new Error('Browser page was closed')))
  }

  static connect(url: string, signal: AbortSignal): Promise<CdpConnection> {
    return new Promise((resolvePromise, reject) => {
      const socket = new WebSocket(url)
      const cancel = () => { socket.close(); reject(new Error('Browser operation was cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
      socket.addEventListener('open', () => { signal.removeEventListener('abort', cancel); resolvePromise(new CdpConnection(socket)) }, { once: true })
      socket.addEventListener('error', () => { signal.removeEventListener('abort', cancel); reject(new Error('Browser protocol connection failed')) }, { once: true })
    })
  }

  request(method: string, params: object, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error('Browser operation was cancelled'))
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      const cancel = () => { this.pending.delete(id); reject(new Error('Browser operation was cancelled')) }
      signal.addEventListener('abort', cancel, { once: true })
      this.pending.set(id, { resolve: (value) => { signal.removeEventListener('abort', cancel); resolvePromise(value) }, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() { this.socket.close(); this.rejectPending(new Error('Browser connection closed')) }
  private rejectPending(error: Error) { for (const waiter of this.pending.values()) waiter.reject(error); this.pending.clear() }
}

function browserTools(bridge: BrowserBridge): ToolDefinition[] {
  return [
    tool('browser_open', 'Open an HTTP(S) page in the isolated Xiaoyin browser and return a semantic snapshot.', { url: { type: 'string', maxLength: 4096 } }, ['url'], (input, signal) => bridge.open(requiredString(input.url, 'url', 4096), signal)),
    tool('browser_snapshot', 'Read the active browser page as structured text, links and form controls.', {}, [], (_input, signal) => bridge.snapshot(signal)),
    tool('browser_click', 'Click an element in the active browser page by CSS selector.', { selector: { type: 'string', maxLength: MAX_SELECTOR_CHARS } }, ['selector'], (input, signal) => bridge.click(requiredString(input.selector, 'selector', MAX_SELECTOR_CHARS), signal)),
    tool('browser_type', 'Replace the value of an input or textarea in the active browser page.', { selector: { type: 'string', maxLength: MAX_SELECTOR_CHARS }, text: { type: 'string', maxLength: MAX_INPUT_CHARS } }, ['selector', 'text'], (input, signal) => bridge.type(requiredString(input.selector, 'selector', MAX_SELECTOR_CHARS), requiredString(input.text, 'text', MAX_INPUT_CHARS), signal)),
    screenshotTool(bridge),
  ]
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<BrowserSnapshot>): ToolDefinition {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false }, output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }, execute(args, execution) { return execute(record(args), execution.signal) }, isConcurrencySafe: () => false }
}

function screenshotTool(bridge: BrowserBridge): ToolDefinition {
  return { name: 'browser_screenshot', description: 'Capture the active browser page.', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: {}, render: (_args, value) => { const result = value as unknown as { snapshot: BrowserSnapshot; image: ImageAttachmentRef }; return [{ type: 'text', text: JSON.stringify(result.snapshot, null, 2) }, { type: 'image', attachment: result.image }] } }, execute(_args, execution) { return bridge.screenshot(execution.signal) }, isConcurrencySafe: () => false }
}

export function validateBrowserUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Browser only accepts HTTP(S) URLs without embedded credentials')
  return url.toString()
}

export function browserApprovalReason(toolName: string, args: unknown): string {
  const input = record(args)
  if (toolName === 'browser_type') return `向浏览器元素 ${validateSelector(input.selector)} 输入内容`
  return `点击浏览器元素 ${validateSelector(input.selector)}`
}

function validateSelector(value: unknown): string { return requiredString(value, 'selector', MAX_SELECTOR_CHARS) }
function requiredString(value: unknown, name: string, limit: number): string { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${name} is invalid`); return value }
function record(value: unknown): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser protocol returned an invalid object'); return value as Record<string, any> }
function normalizeSnapshot(value: Record<string, unknown>): BrowserSnapshot { return { title: String(value.title ?? '').slice(0, 500), url: String(value.url ?? '').slice(0, 4096), text: String(value.text ?? '').slice(0, MAX_OUTPUT_CHARS), links: Array.isArray(value.links) ? value.links.slice(0, 200) as BrowserSnapshot['links'] : [], controls: Array.isArray(value.controls) ? value.controls.slice(0, 200) as BrowserSnapshot['controls'] : [] } }
function delay(milliseconds: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)) }
async function settle(signal: AbortSignal) { await Promise.race([delay(450), new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Browser operation was cancelled')), { once: true }))]) }

async function browserExecutable(configured: string): Promise<string> {
  const candidates = [configured, process.env.XIAOYIN_BROWSER_EXECUTABLE, ...(process.platform === 'win32' ? [
    resolve(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
    resolve(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    resolve(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/google-chrome', '/usr/bin/chromium'])].filter(Boolean) as string[]
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch { /* try next installed browser */ } }
  throw new Error('No supported Chrome or Edge browser installation was found')
}

const SNAPSHOT_SCRIPT = `(() => {
  const selector = (el) => { if (el.id) return '#' + CSS.escape(el.id); const name = el.getAttribute('name'); if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]'; const path = []; let node = el; while (node && node !== document.body && path.length < 5) { const tag = node.tagName.toLowerCase(); const siblings = [...node.parentElement.children].filter(x => x.tagName === node.tagName); path.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : '')); node = node.parentElement } return path.join(' > ') }
  const visible = (el) => { const style = getComputedStyle(el); const rect = el.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 }
  return { title: document.title, url: location.href, text: (document.body?.innerText ?? '').slice(0, ${MAX_OUTPUT_CHARS}), links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 200).map(el => ({ text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 300), href: el.href, selector: selector(el) })), controls: [...document.querySelectorAll('button,input,textarea,select')].filter(visible).slice(0, 200).map(el => ({ tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 300), selector: selector(el) })) }
})()`
