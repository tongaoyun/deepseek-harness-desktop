import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, toolGroup } from './tool-discovery-plugin.js'

it('maps product and upstream tool names to the right groups', () => {
  expect(toolGroup('read')).toBe('files')
  expect(toolGroup('local_files_read_text')).toBe('files')
  expect(toolGroup('office_xlsx_read')).toBe('office')
  expect(toolGroup('knowledge_search')).toBe('knowledge')
  expect(toolGroup('mcp_erp_store_sales_summary')).toBe('connectors')
  expect(toolGroup('skills_search')).toBe('skills')
  expect(toolGroup('browser_open')).toBe('web')
  expect(toolGroup('bash')).toBe('code')
  expect(toolGroup('computer_use_observe')).toBe('desktop')
})

it('starts with one discovery schema, unlocks only selected tools per agent and relocks on a new turn', async () => {
  const names = ['tool_discover', 'ask_user_question', 'exit_plan_mode', 'task_report', 'office_xlsx_read', 'knowledge_search', 'mcp_erp_store_sales_summary', 'local_files_publish']
  const callbacks = new Map<string, (event: never, next?: () => string) => unknown>()
  let discovery!: ToolDefinition
  const visible = new Map<object, string[]>()
  const global = { schemas: () => names.map((name) => ({ name })), get: (name: string) => names.includes(name) ? { name } : undefined,
    register: (tool: ToolDefinition) => { discovery = tool; return () => {} } }
  const ctx = { tools: global, on: (event: string, callback: (event: never, next?: () => string) => unknown) => { callbacks.set(event, callback); return () => {} }, effect: () => {} } as unknown as Context
  apply(ctx)
  const agent = () => {
    const value = { ctx: { tools: { restrict: ({ allow }: { allow: string[] }) => {
      visible.set(value, allow)
      return () => { visible.delete(value) }
    } } } }
    callbacks.get('agent/created')!({ agent: value } as never)
    return value
  }
  const first = agent(), second = agent()
  expect(visible.get(first)).toEqual(['tool_discover', 'ask_user_question', 'exit_plan_mode'])
  callbacks.get('agent/pre-step')!({ agent: first, turn: 1 } as never, () => 'next')
  const receipt = await discovery.execute({ groups: ['office', 'connectors'] }, { agent: first } as never)
  expect(receipt).toMatchObject({ groups: ['office', 'connectors'], toolCount: 4 })
  expect((receipt as { guidance: string }).guidance).toContain('office_xlsx_recalculate')
  expect((receipt as { guidance: string }).guidance).toContain('企业实时数据仅以成功的连接器工具回执为准')
  expect((receipt as { guidance: string }).guidance).not.toContain('操作本机应用前观察目标窗口')
  expect(visible.get(first)).toContain('office_xlsx_read')
  expect(visible.get(first)).toContain('exit_plan_mode')
  expect(visible.get(first)).toContain('task_report')
  expect(visible.get(first)).not.toContain('knowledge_search')
  const fileReceipt = await discovery.execute({ groups: ['files'] }, { agent: first } as never)
  expect((fileReceipt as { guidance: string }).guidance).toContain('local_files_publish')
  expect(visible.get(first)).toContain('local_files_publish')
  expect(visible.get(second)).toEqual(['tool_discover', 'ask_user_question', 'exit_plan_mode'])
  callbacks.get('agent/pre-step')!({ agent: first, turn: 1 } as never, () => 'next')
  expect(visible.get(first)).toContain('office_xlsx_read')
  callbacks.get('agent/pre-step')!({ agent: first, turn: 2 } as never, () => 'next')
  expect(visible.get(first)).toEqual(['tool_discover', 'ask_user_question', 'exit_plan_mode'])
  await expect(discovery.execute({ groups: ['unknown'] }, { agent: first } as never)).rejects.toThrow('无效的工具类别')
})

it('cleans restrictions when an agent is disposed and ignores stale pre-step events', () => {
  const names = ['tool_discover', 'ask_user_question', 'exit_plan_mode']
  const callbacks = new Map<string, (event: never, next?: () => string) => unknown>()
  let discovery: ToolDefinition | undefined
  let releaseCount = 0
  const global = {
    schemas: () => names.map((name) => ({ name })),
    get: (name: string) => names.includes(name) ? { name } : undefined,
    register: (tool: ToolDefinition) => { discovery = tool; return () => {} },
  }
  const ctx = {
    tools: global,
    on: (event: string, callback: (event: never, next?: () => string) => unknown) => { callbacks.set(event, callback); return () => {} },
    effect: () => {},
  } as unknown as Context
  apply(ctx)
  const value = {
    ctx: {
      tools: {
        restrict: () => {
          releaseCount += 1
          return () => { releaseCount += 1 }
        },
      },
    },
  }
  callbacks.get('agent/created')!({ agent: value } as never)
  callbacks.get('agent/disposed')!({ agent: value } as never)
  expect(releaseCount).toBe(2)
  expect(() => callbacks.get('agent/pre-step')!({ agent: value, turn: 1 } as never, () => 'next')).not.toThrow()
  expect(releaseCount).toBe(2)
  expect(discovery).toBeDefined()
})
