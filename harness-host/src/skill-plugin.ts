import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export const name = 'xiaoyin-skills'
export const inject = ['tools']
export interface Config { readOnly?: boolean }
export const Config = z.object({ readOnly: z.boolean().default(false) })

export class SkillClient {
  constructor(private readonly url: string, private readonly token: string) {}
  async request(action: string, input: unknown): Promise<unknown> {
    const url = new URL(this.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('技能管理仅使用本机桌面服务')
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(100000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, input }) })
    if (!response.ok) throw new Error(`技能请求失败：${response.status}`)
    const result: unknown = await response.json()
    if (result && typeof result === 'object' && 'error' in result) throw new Error(String(result.error))
    return result
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const url = process.env.XIAOYIN_LOCAL_SKILL_URL, token = process.env.XIAOYIN_LOCAL_SKILL_TOKEN
  if (!url || !token) return
  const client = new SkillClient(url, token)
  const definitions: [string, string, Record<string, unknown>, string[]][] = [
    ['search', '搜索当前企业目录和本机的独立技能，返回真实 ID、安装与启用状态。query 留空列出技能。', { query: { type: 'string', maxLength: 200 } }, []],
    ['inspect_github', '读取公开 GitHub 仓库或 tree 技能目录，列出 SKILL.md 候选及下载摘要，不安装。多个候选应让用户选择，不要猜测。', { sourceUrl: { type: 'string', maxLength: 2000 } }, ['sourceUrl']],
    ['install', '安装技能，需用户确认。企业技能传 search 返回的 id；GitHub 技能传 inspect_github 返回的 archiveId 和精确 path（根目录为空字符串）。安装后下一轮任务才加载。已有同名本地技能可能被更新。', {
      id: { type: 'string' }, archiveId: { type: 'string' }, path: { type: 'string' },
    }, []],
  ]
  const disposers = definitions.filter(([action]) => !config.readOnly || action === 'search').map(([action, description, properties, required]) => {
    const tool: ToolDefinition = {
      name: `skills_${action}`, description, parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (input) => client.request(action, input), isConcurrencySafe: () => action === 'search',
    }
    return ctx.tools.register(tool)
  })
  const stop = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'skills_install'
    ? Promise.resolve({ kind: 'ask' as const, reason: '安装所选技能到本机？同名本地技能可能被更新，下一轮任务开始可用。' }) : next())
  ctx.effect(() => () => { stop(); for (const dispose of disposers.reverse()) dispose() }, 'desktop skill tools')
}
