import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export const name = 'xiaoyin-local-computer-use'
export const inject = ['tools', 'attachments']

const ALL_TOOLS = [
  'computer_use_observe', 'computer_use_click', 'computer_use_type', 'computer_use_key', 'computer_use_scroll',
] as const
const MAX_ELEMENTS = 160
const MAX_TEXT = 2_000
const MAX_OUTPUT = 1024 * 1024
const KEY_CODES: Record<string, number> = {
  ENTER: 0x0D, TAB: 0x09, ESC: 0x1B, BACKSPACE: 0x08, DELETE: 0x2E, SPACE: 0x20,
  LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, HOME: 0x24, END: 0x23,
  PAGEUP: 0x21, PAGEDOWN: 0x22,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  A: 0x41, C: 0x43, F: 0x46, N: 0x4E, O: 0x4F, P: 0x50, S: 0x53, V: 0x56, W: 0x57, X: 0x58, Y: 0x59, Z: 0x5A,
}
const MODIFIER_CODES: Record<string, number> = { CTRL: 0x11, ALT: 0x12, SHIFT: 0x10, WIN: 0x5B }

export interface Config { enabled?: boolean; tools?: string[] }
export const Config = z.object({
  enabled: z.boolean().default(false),
  tools: z.array(z.string()).default([]),
})

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled !== true || process.platform !== 'win32') return
  const selected = validateToolSelection(config.tools ?? [])
  if (selected.size === 0) return
  const bridge = new ComputerUseBridge(ctx)
  const definitions = computerUseTools(bridge).filter((tool) => selected.has(tool.name))
  const unregister = definitions.map((tool) => ctx.tools.register(tool))
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (!selected.has(exec.name)) return next()
    return Promise.resolve({ kind: 'ask' as const, reason: approvalReason(exec.name, exec.arguments) })
  })
  ctx.effect(() => () => {
    stopApprovalPolicy()
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin Windows computer use bridge')
}

export class ComputerUseBridge {
  private readonly screenshotPath: string

  constructor(private readonly ctx: Context, private readonly runner: PowerShellRunner = runPowerShell) {
    this.screenshotPath = resolve(process.env.DSH_HOME ?? process.cwd(), 'computer-use/current-screen.png')
  }

  observe(maxElements: number, signal: AbortSignal) {
    return this.execute('', maxElements, signal)
  }

  click(x: number, y: number, button: 'left' | 'right', clickCount: number, maxElements: number, signal: AbortSignal) {
    const flag = button === 'left' ? 0 : 1
    return this.execute(`$xiaoyinPoint = Convert-XiaoyinPoint ${x} ${y}\n[XiaoyinInput]::Click($xiaoyinPoint.X, $xiaoyinPoint.Y, ${flag}, ${clickCount})`, maxElements, signal)
  }

  type(text: string, maxElements: number, signal: AbortSignal) {
    const encoded = Buffer.from(text, 'utf8').toString('base64')
    return this.execute(`$xiaoyinText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))\n[XiaoyinInput]::TypeText($xiaoyinText)`, maxElements, signal)
  }

  key(key: string, modifiers: string[], maxElements: number, signal: AbortSignal) {
    const code = KEY_CODES[key]
    const modifierCodes = modifiers.map((modifier) => MODIFIER_CODES[modifier])
    return this.execute(`[XiaoyinInput]::Key(${code}, [uint16[]]@(${modifierCodes.join(',')}))`, maxElements, signal)
  }

  scroll(x: number, y: number, delta: number, maxElements: number, signal: AbortSignal) {
    return this.execute(`$xiaoyinPoint = Convert-XiaoyinPoint ${x} ${y}\n[XiaoyinInput]::Scroll($xiaoyinPoint.X, $xiaoyinPoint.Y, ${delta})`, maxElements, signal)
  }

  private async execute(action: string, maxElements: number, signal: AbortSignal): Promise<ComputerObservation> {
    await mkdir(dirname(this.screenshotPath), { recursive: true })
    const stdout = await this.runner(observationScript(action, this.screenshotPath, maxElements), signal)
    const encoded = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('Windows Computer Use did not return a valid observation')
    const observation = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Omit<ComputerObservation, 'image'>
    const image = await this.ctx.attachments.saveImage({
      data: await readFile(this.screenshotPath), mediaType: 'image/png', name: 'current-screen.png',
    })
    return { ...observation, image }
  }
}

interface ComputerObservation {
  screen: { width: number; height: number }
  activeWindow: { title: string; processId: number }
  elements: Array<{ name: string; automationId: string; controlType: string; x: number; y: number; width: number; height: number }>
  truncated: boolean
  image: ImageAttachmentRef
}

type PowerShellRunner = (script: string, signal: AbortSignal) => Promise<string>

function computerUseTools(bridge: ComputerUseBridge): ToolDefinition[] {
  return [
    tool('computer_use_observe', 'Capture the current Windows desktop and list visible accessibility elements using screenshot pixel coordinates.', {
      description: purposeProperty(), maxElements: maxElementsProperty(),
    }, ['description'], (input, signal) => bridge.observe(integer(input.maxElements, 100, 1, MAX_ELEMENTS), signal)),
    tool('computer_use_click', 'Click one coordinate from the latest screenshot, then return the updated Windows desktop observation.', {
      x: coordinateProperty(), y: coordinateProperty(),
      button: { type: 'string', enum: ['left', 'right'], default: 'left' },
      clickCount: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
      description: purposeProperty(), maxElements: maxElementsProperty(),
    }, ['x', 'y', 'description'], (input, signal) => bridge.click(
      integer(input.x, undefined, 0, 2560), integer(input.y, undefined, 0, 2560),
      input.button === 'right' ? 'right' : 'left', integer(input.clickCount, 1, 1, 2),
      integer(input.maxElements, 100, 1, MAX_ELEMENTS), signal,
    )),
    tool('computer_use_type', 'Type Unicode text into the currently focused Windows control, then return the updated desktop observation.', {
      text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
      description: purposeProperty(), maxElements: maxElementsProperty(),
    }, ['text', 'description'], (input, signal) => bridge.type(requiredString(input.text, 'text', MAX_TEXT),
      integer(input.maxElements, 100, 1, MAX_ELEMENTS), signal)),
    tool('computer_use_key', 'Press one allowlisted Windows key, optionally with modifiers, then return the updated desktop observation.', {
      key: { type: 'string', enum: Object.keys(KEY_CODES) },
      modifiers: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', enum: Object.keys(MODIFIER_CODES) }, default: [] },
      description: purposeProperty(), maxElements: maxElementsProperty(),
    }, ['key', 'description'], (input, signal) => bridge.key(
      requiredKey(input.key), modifiers(input.modifiers), integer(input.maxElements, 100, 1, MAX_ELEMENTS), signal,
    )),
    tool('computer_use_scroll', 'Scroll at one coordinate from the latest screenshot, then return the updated observation.', {
      x: coordinateProperty(), y: coordinateProperty(),
      delta: { type: 'integer', minimum: -1200, maximum: 1200, description: 'Signed wheel delta; negative scrolls down.' },
      description: purposeProperty(), maxElements: maxElementsProperty(),
    }, ['x', 'y', 'delta', 'description'], (input, signal) => bridge.scroll(
      integer(input.x, undefined, 0, 2560), integer(input.y, undefined, 0, 2560),
      integer(input.delta, undefined, -1200, 1200), integer(input.maxElements, 100, 1, MAX_ELEMENTS), signal,
    )),
  ]
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], execute: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ComputerObservation>): ToolDefinition {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: {},
      render: (_args, value) => {
        const observation = value as unknown as ComputerObservation
        const { image, ...text } = observation
        return [
          { type: 'text', text: JSON.stringify(text, null, 2) },
          { type: 'image', attachment: image },
        ]
      },
    },
    execute(args, exec) { return execute(record(args), exec.signal) },
    isConcurrencySafe: () => false,
  }
}

export function validateToolSelection(values: string[]): Set<string> {
  const allowed = new Set<string>(ALL_TOOLS)
  const unique = new Set(values)
  const unsupported = [...unique].filter((value) => !allowed.has(value))
  if (unsupported.length) throw new Error(`Unsupported Computer Use tools: ${unsupported.join(', ')}`)
  return unique
}

export function approvalReason(toolName: string, args: unknown): string {
  const input = record(args)
  const purpose = requiredString(input.description, 'description', 500)
  const action = ({
    computer_use_observe: '截取当前桌面并读取界面元素',
    computer_use_click: `点击屏幕坐标 (${input.x}, ${input.y})`,
    computer_use_type: `向当前焦点输入 ${typeof input.text === 'string' ? input.text.length : 0} 个字符`,
    computer_use_key: `按键 ${formatKey(input.key, input.modifiers)}`,
    computer_use_scroll: `在屏幕坐标 (${input.x}, ${input.y}) 滚动 ${input.delta}`,
  } as Record<string, string>)[toolName] ?? toolName
  return [`操作 Windows 桌面：${action}`, `用途：${purpose}`, '操作完成后会重新截取当前桌面。'].join('\n')
}

function runPowerShell(script: string, signal: AbortSignal): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolvePromise, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0
    const collect = (target: Buffer[], value: Buffer) => {
      bytes += value.length
      if (bytes <= MAX_OUTPUT) target.push(value)
      else child.kill()
    }
    child.stdout.on('data', (value: Buffer) => collect(stdout, value))
    child.stderr.on('data', (value: Buffer) => collect(stderr, value))
    const stop = () => child.kill()
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => child.kill(), 20_000)
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', stop)
      if (signal.aborted) { reject(new Error('Computer Use was cancelled')); return }
      if (code !== 0) { reject(new Error(`Windows Computer Use failed: ${Buffer.concat(stderr).toString('utf8').slice(0, 2000)}`)); return }
      resolvePromise(Buffer.concat(stdout).toString('utf8'))
    })
  })
}

function observationScript(action: string, screenshotPath: string, maxElements: number): string {
  const encodedPath = Buffer.from(screenshotPath, 'utf8').toString('base64')
  return `${WINDOWS_INPUT}\n${action}\nStart-Sleep -Milliseconds 250\n${WINDOWS_OBSERVE}\n$xiaoyinPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))\n$xiaoyinObservation = Get-XiaoyinObservation -ScreenshotPath $xiaoyinPath -MaxElements ${maxElements}\n$xiaoyinJson = $xiaoyinObservation | ConvertTo-Json -Depth 6 -Compress\n[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($xiaoyinJson))`
}

const WINDOWS_INPUT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XiaoyinInput {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION value; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT keyboard; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
  public static void Initialize() { SetProcessDPIAware(); }
  public static void Click(int x, int y, int button, int count) { SetProcessDPIAware(); SetCursorPos(x, y); uint down = button == 1 ? 0x0008u : 0x0002u; uint up = button == 1 ? 0x0010u : 0x0004u; for (int i=0;i<count;i++){ mouse_event(down,0,0,0,UIntPtr.Zero); mouse_event(up,0,0,0,UIntPtr.Zero); } }
  public static void Scroll(int x, int y, int delta) { SetProcessDPIAware(); SetCursorPos(x, y); mouse_event(0x0800u,0,0,delta,UIntPtr.Zero); }
  public static void Key(ushort key, ushort[] modifiers) { foreach (ushort value in modifiers) keybd_event((byte)value,0,0,UIntPtr.Zero); keybd_event((byte)key,0,0,UIntPtr.Zero); keybd_event((byte)key,0,2,UIntPtr.Zero); for(int i=modifiers.Length-1;i>=0;i--) keybd_event((byte)modifiers[i],0,2,UIntPtr.Zero); }
  public static void TypeText(string text) { foreach(char value in text) { var inputs = new INPUT[2]; inputs[0].type=1; inputs[0].value.keyboard.scan=value; inputs[0].value.keyboard.flags=4; inputs[1].type=1; inputs[1].value.keyboard.scan=value; inputs[1].value.keyboard.flags=6; if (SendInput(2,inputs,Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("Unable to type text"); } }
}
'@
[XiaoyinInput]::Initialize()
Add-Type -AssemblyName System.Windows.Forms
function Convert-XiaoyinPoint([int]$X, [int]$Y) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $scale = [Math]::Min(1.0, [Math]::Min(1600.0 / $bounds.Width, 1600.0 / $bounds.Height))
  $width = [Math]::Max(1, [int][Math]::Round($bounds.Width * $scale)); $height = [Math]::Max(1, [int][Math]::Round($bounds.Height * $scale))
  if ($X -lt 0 -or $Y -lt 0 -or $X -ge $width -or $Y -ge $height) { throw 'Computer Use coordinate is outside the latest screenshot' }
  [ordered]@{ X=[int][Math]::Round($bounds.X + ($X / $scale)); Y=[int][Math]::Round($bounds.Y + ($Y / $scale)) }
}
[XiaoyinInput] | Out-Null`

const WINDOWS_OBSERVE = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-XiaoyinObservation([string]$ScreenshotPath, [int]$MaxElements) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $scale = [Math]::Min(1.0, [Math]::Min(1600.0 / $bounds.Width, 1600.0 / $bounds.Height))
  $capture = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($capture)
  try { $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size) } finally { $graphics.Dispose() }
  $width = [Math]::Max(1, [int][Math]::Round($bounds.Width * $scale)); $height = [Math]::Max(1, [int][Math]::Round($bounds.Height * $scale))
  if ($width -ne $bounds.Width -or $height -ne $bounds.Height) { $image = New-Object System.Drawing.Bitmap($capture, $width, $height); $capture.Dispose() } else { $image = $capture }
  try { $image.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  $processId = if ($null -eq $focused) { 0 } else { $focused.Current.ProcessId }
  $title = ''; $window = $focused
  while ($null -ne $window) { if ($window.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) { $title = $window.Current.Name; break }; $window = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($window) }
  $items = @(); $truncated = $false
  if ($processId -gt 0 -and $null -ne $window) {
    $nodes = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($index = 0; $index -lt $nodes.Count; $index++) {
      try {
        $node = $nodes.Item($index); $name = $node.Current.Name; $automationId = $node.Current.AutomationId
        if ([String]::IsNullOrWhiteSpace($name) -and [String]::IsNullOrWhiteSpace($automationId)) { continue }
        if ($items.Count -ge $MaxElements) { $truncated = $true; break }
        $rect = $node.Current.BoundingRectangle
        $items += [ordered]@{ name=$name; automationId=$automationId; controlType=$node.Current.ControlType.ProgrammaticName.Replace('ControlType.',''); x=[int][Math]::Round(($rect.X - $bounds.X) * $scale); y=[int][Math]::Round(($rect.Y - $bounds.Y) * $scale); width=[int][Math]::Round($rect.Width * $scale); height=[int][Math]::Round($rect.Height * $scale) }
      } catch [System.Windows.Automation.ElementNotAvailableException] { continue }
    }
  }
  [ordered]@{ screen=[ordered]@{width=$width;height=$height}; activeWindow=[ordered]@{title=$title;processId=$processId}; elements=$items; truncated=$truncated }
}`

function purposeProperty() { return { type: 'string', minLength: 1, maxLength: 500, description: 'Plain-language purpose shown in the native approval dialog.' } }
function maxElementsProperty() { return { type: 'integer', minimum: 1, maximum: MAX_ELEMENTS, default: 100 } }
function coordinateProperty() { return { type: 'integer', minimum: 0, maximum: 2560, description: 'Pixel coordinate from the latest screenshot.' } }
function record(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Computer Use arguments must be an object'); return value as Record<string, unknown> }
function requiredString(value: unknown, name: string, max: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be a non-empty string`); return value }
function integer(value: unknown, fallback: number | undefined, minimum: number, maximum: number): number { const result = value === undefined ? fallback : value; if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`integer must be between ${minimum} and ${maximum}`); return result }
function requiredKey(value: unknown): string { const key = requiredString(value, 'key', 16).toUpperCase(); if (!(key in KEY_CODES)) throw new Error('Unsupported key'); return key }
function modifiers(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 4 || value.some((item) => typeof item !== 'string' || !(item.toUpperCase() in MODIFIER_CODES))) throw new Error('Invalid key modifiers'); return [...new Set(value.map((item) => String(item).toUpperCase()))] }
function formatKey(key: unknown, value: unknown): string { const values = Array.isArray(value) ? value.map(String) : []; return [...values, String(key ?? '')].filter(Boolean).join('+') }
