import { expect, it, vi } from 'vitest'
import { DesktopToolBridge } from './desktop-tool-bridge.js'
import { apply, SkillClient } from './skill-plugin.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

it('uses private loopback authentication and relays actual inspection and failure receipts', async () => {
  const bridge = new DesktopToolBridge((value) => {
    if (!('params' in value)) return
    const params = value.params as { requestId: string; action: string }
    bridge.respond(params.requestId, params.action === 'inspect_github' ? { archiveId: 'sha', candidates: [{ path: '' }] } : { error: '技能已下架' })
  }, 'skill', ['search', 'inspect_github', 'install'], 1000)
  const endpoint = await bridge.start()
  try {
    const client = new SkillClient(endpoint.url, endpoint.token)
    await expect(client.request('inspect_github', {})).resolves.toEqual({ archiveId: 'sha', candidates: [{ path: '' }] })
    await expect(client.request('install', { id: 'gone' })).rejects.toThrow('技能已下架')
    await expect(new SkillClient(endpoint.url, 'wrong').request('search', {})).rejects.toThrow('404')
    await expect(new SkillClient('https://example.com', endpoint.token).request('search', {})).rejects.toThrow('仅使用本机')
  } finally { await bridge.close() }
})

it('requires install approval and only exposes search in plan mode', async () => {
  vi.stubEnv('XIAOYIN_LOCAL_SKILL_URL', 'http://127.0.0.1:12345/skill')
  vi.stubEnv('XIAOYIN_LOCAL_SKILL_TOKEN', 'test')
  const registered: ToolDefinition[] = []
  let handler!: (exec: { name: string }, next: () => unknown) => unknown
  const ctx = { tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } },
    on: (_event: string, callback: typeof handler) => { handler = callback; return () => {} }, effect: vi.fn() } as unknown as Context
  try {
    apply(ctx)
    expect(registered.map((tool) => tool.name)).toEqual(['skills_search', 'skills_inspect_github', 'skills_install'])
    expect(await handler({ name: 'skills_install' }, () => 'allow')).toMatchObject({ kind: 'ask' })
    expect(handler({ name: 'skills_search' }, () => 'allow')).toBe('allow')
    registered.length = 0
    apply(ctx, { readOnly: true })
    expect(registered.map((tool) => tool.name)).toEqual(['skills_search'])
  } finally { vi.unstubAllEnvs() }
})
