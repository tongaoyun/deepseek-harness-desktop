import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { LocalFileBridge, discoverAuthorizedRoots } from './local-files-plugin.js'

export const name = 'xiaoyin-local-shell'
export const inject = ['tools']

const MAX_COMMAND_CHARS = 16 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_TIMEOUT_MS = 120_000

export interface Config { roots?: string[]; enabled?: boolean }
export const Config = z.object({ roots: z.array(z.string()).default([]), enabled: z.boolean().default(false) })

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.enabled !== true) return
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return
  const bridge = new LocalFileBridge(roots)
  const unregister = ctx.tools.register(shellTool(bridge))
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'local_shell_run') return next()
    const input = asRecord(exec.arguments)
    return Promise.resolve({
      kind: 'ask' as const,
      reason: [
        '在员工授权目录中执行本地 Shell 命令',
        `用途：${boundedString(input.description, '未说明', 500)}`,
        `工作目录：${boundedString(input.workdir, '.', 4096)}`,
        '命令：',
        boundedString(input.command, '未提供', MAX_COMMAND_CHARS),
      ].join('\n'),
    })
  })
  ctx.effect(() => () => { stopApprovalPolicy(); unregister() }, 'xiaoyin local shell bridge')
}

function shellTool(bridge: LocalFileBridge): ToolDefinition {
  return {
    name: 'local_shell_run',
    description: 'Run one PowerShell or Bash command starting in an employee-authorized directory. Every call requires employee confirmation.',
    parameters: {
      type: 'object',
      properties: {
        rootId: { type: 'string', minLength: 1, maxLength: 200, description: 'Authorized root ID.' },
        workdir: { type: 'string', maxLength: 4096, default: '', description: 'Relative working directory.' },
        command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_CHARS },
        description: { type: 'string', minLength: 1, maxLength: 500, description: 'Plain-language purpose shown in the approval dialog.' },
        timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_TIMEOUT_MS, default: 30_000 },
      },
      required: ['rootId', 'command', 'description'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const input = asRecord(args)
      const rootId = requiredString(input.rootId, 'rootId', 200)
      const workdir = optionalString(input.workdir, 'workdir', 4096)
      const command = requiredString(input.command, 'command', MAX_COMMAND_CHARS)
      const timeoutMs = optionalInteger(input.timeoutMs, 30_000)
      const { root, target } = await bridge.resolveExisting(rootId, workdir)
      if (!(await stat(target)).isDirectory()) throw new Error('Shell working directory must be a directory')
      const result = await runCommand(command, target, timeoutMs, exec.signal)
      return { rootId: root.id, rootName: root.name, workdir: bridge.visiblePath(root, target), ...result }
    },
    isConcurrencySafe: () => false,
  }
}

export async function runCommand(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<object> {
  const windows = process.platform === 'win32'
  const executable = windows ? 'powershell.exe' : '/bin/bash'
  const args = windows
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
    : ['--noprofile', '--norc', '-c', command]
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: safeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    const collect = (chunks: Buffer[], value: Buffer, kind: 'stdout' | 'stderr') => {
      const current = kind === 'stdout' ? stdoutBytes : stderrBytes
      const remaining = MAX_OUTPUT_BYTES - current
      if (remaining > 0) chunks.push(value.subarray(0, remaining))
      if (value.length > remaining) truncated = true
      if (kind === 'stdout') stdoutBytes += value.length; else stderrBytes += value.length
      if (stdoutBytes > MAX_OUTPUT_BYTES * 2 || stderrBytes > MAX_OUTPUT_BYTES * 2) child.kill()
    }
    child.stdout.on('data', (value: Buffer) => collect(stdout, value, 'stdout'))
    child.stderr.on('data', (value: Buffer) => collect(stderr, value, 'stderr'))
    const stop = () => child.kill()
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', reject)
    child.once('close', (code, closeSignal) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (signal.aborted) { reject(new Error('Shell command was cancelled')); return }
      resolve({
        exitCode: code,
        signal: closeSignal,
        timedOut,
        truncated,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']
    : ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR']
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

function asRecord(value: unknown): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Shell tool arguments must be an object'); return value as Record<string, unknown> }
function requiredString(value: unknown, name: string, max: number): string { if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${name} must be a non-empty string`); return value }
function optionalString(value: unknown, name: string, max: number): string { if (value === undefined) return ''; if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be a string`); return value }
function optionalInteger(value: unknown, fallback: number): number { if (value === undefined) return fallback; if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000 || value > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be between 1000 and ${MAX_TIMEOUT_MS}`); return value }
function boundedString(value: unknown, fallback: string, max: number): string { return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : fallback }
