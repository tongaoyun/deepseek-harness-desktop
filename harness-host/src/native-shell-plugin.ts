import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'xiaoyin-native-shell'
export const inject = ['tools']

const MAX_COMMAND_CHARS = 16 * 1024

export interface Config {
  enabled?: boolean
  requireApproval?: boolean
  cwd?: string
  dshHome?: string
}

export const Config = z.object({
  enabled: z.boolean().default(false),
  requireApproval: z.boolean().default(true),
  cwd: z.string(),
  dshHome: z.string(),
})

/**
 * Add Xiaoyin's approval policy to the shell owned by the sdk-minimal profile.
 * Process execution, cancellation and terminal lifecycle stay in Harness.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled !== true) return

  if (config.requireApproval === false) return
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'bash' && exec.name !== 'pwsh') return next()
    const input = asRecord(exec.arguments)
    if (!shellCommandRequiresApproval(input.command)) return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: [
        `执行本地 ${exec.name === 'pwsh' ? 'PowerShell' : 'Bash'} 命令`,
        `用途：${boundedString(input.description, '未说明', 500)}`,
        `工作目录：${boundedString(input.workdir, config.cwd ?? '.', 4096)}`,
        input.run_in_background === true ? '运行方式：后台任务' : '运行方式：前台',
        '命令：',
        boundedString(input.command, '未提供', MAX_COMMAND_CHARS),
      ].join('\n'),
    })
  })
  ctx.effect(() => () => stopApprovalPolicy(), 'xiaoyin native shell approval policy')
}

export function shellCommandRequiresApproval(value: unknown): boolean {
  if (typeof value !== 'string') return true
  const command = value.trim()
  if (!command) return true
  const normalized = command.toLocaleLowerCase('en-US')
  return [
    /(^|[\s;&|])(sudo|su|doas)([\s;&|]|$)/,
    /(^|[\s;&|])(rm|rmdir|del|erase|remove-item)([\s;&|]|$)/,
    /(^|[\s;&|])(dd|mkfs|diskpart|format)([\s;&|]|$)/,
    /(^|[\s;&|])(shutdown|reboot|halt|poweroff|kill|killall|taskkill)([\s;&|]|$)/,
    /(^|[\s;&|])(chmod|chown|takeown|icacls)([\s;&|]|$)/,
    /(^|[\s;&|])git\s+(push|reset|clean|checkout\s+--)([\s;&|]|$)/,
    /(^|[\s;&|])(npm|pnpm|yarn)\s+(publish|unpublish)([\s;&|]|$)/,
    /(^|[\s;&|])(curl|wget)[^\n]*(\|\s*(bash|sh|zsh)|invoke-expression|\biex\b)/,
    /(^|[\s;&|])(reg\s+delete|sc\s+delete|bcdedit)([\s;&|]|$)/,
  ].some((pattern) => pattern.test(normalized))
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function boundedString(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : fallback
}
