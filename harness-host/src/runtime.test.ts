import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, lstat, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { applyMemoryContext, assertHarnessDependencyClosure, DeepSeekHarnessRuntime, ensureExternalHarnessPlugins, hasConfiguredLspServers, hasHarnessPackage, runSessionTurn } from './runtime.js'
import { visibleTaskPrompt, withTaskInstructions } from './task-instructions.js'

it('passes shared execution and delivery rules to actual runtime turns, including follow-ups', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const observedPrompts: unknown[] = []
  const client = {
    ...fakeClient([]),
    prompt: async (_sessionId: string, content: unknown) => { observedPrompts.push(content); return 'message-2' },
    subscribeSessionTree: () => fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '完成检查。' }] } }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]).subscribeSessionTree(),
  }
  Object.assign(runtime, { harness: { start: async () => {}, close: async () => {}, client } })
  await runtime.run({ sessionId: 'session-1', prompt: '只检查，不修改' }, () => {})
  await runtime.run({ sessionId: 'session-1', prompt: '把报告加上汇总行' }, () => {})
  expect(observedPrompts).toHaveLength(2)
  expect(JSON.stringify(observedPrompts[0])).toContain('只检查，不修改')
  expect(JSON.stringify(observedPrompts[1])).toContain('把报告加上汇总行')
  for (const prompt of observedPrompts) {
    expect(JSON.stringify(prompt)).toContain('使用 present 声明实际文件')
    expect(JSON.stringify(prompt)).toContain('文件存在、工具成功或模型回复不等于任务完成')
    expect(JSON.stringify(prompt)).toContain('询问、检查和诊断不代表授权修改')
    expect(JSON.stringify(prompt)).toContain('首次操作前用用户的语言给一句自然进度')
    expect(JSON.stringify(prompt)).toContain('纯问答不播报过程')
    expect(JSON.stringify(prompt)).toContain('最终答复必须自包含用户要的关键结果')
    expect(JSON.stringify(prompt)).toContain('不能用“见上方”“如上”“工具结果中”代替正文')
  }
  expect(withTaskInstructions('用户原文')).toMatch(/本轮任务上下文与请求：\n用户原文$/u)
  expect(withTaskInstructions('用户原文', { useOfficialPresent: true })).toContain('使用 present 声明实际文件')
  expect(withTaskInstructions('用户原文', { useOfficialPresent: true })).not.toContain('使用 local_files_publish 登记实际文件')
  expect(withTaskInstructions('用户原文')).toContain('不要调用工具自报完成状态')
  expect(withTaskInstructions('用户原文').length).toBeLessThan(1_200)
  expect(visibleTaskPrompt('小胤任务执行约定：\n- 先判断本轮意图，运行约定\n\n本轮任务上下文与请求：\n历史问题')).toBe('历史问题')
  await runtime.close()
})

it('uses constructor-scoped environment for execution prompts', async () => {
  const runtime = new DeepSeekHarnessRuntime({ XIAOYIN_MEMORY_CONTEXT: '优先给出结论' })
  const observed: unknown[] = []
  const client = {
    ...fakeClient([]),
    prompt: async (_sessionId: string, content: unknown) => { observed.push(content); return 'message-2' },
    subscribeSessionTree: () => fakeClient([
      eventFor('scoped-env', 'agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      eventFor('scoped-env', 'turn/start', { turn: 1 }),
      eventFor('scoped-env', 'assistant/message', { message: { content: [{ type: 'text', text: '收到' }] } }),
      eventFor('scoped-env', 'turn/end', { reason: { kind: 'completed' } }),
    ]).subscribeSessionTree(),
  }
  Object.assign(runtime, { harness: { start: async () => {}, close: async () => {}, client } })
  await runtime.run({ sessionId: 'scoped-env', prompt: '分析库存' }, () => {})
  expect(JSON.stringify(observed[0])).toContain('优先给出结论')
  await runtime.close()
})

it('keeps the official present contract when authorized roots are present', async () => {
  const runtime = new DeepSeekHarnessRuntime({ XIAOYIN_LOCAL_FILE_ROOTS: '[{"id":"workspace"}]' })
  const observed: unknown[] = []
  const client = {
    ...fakeClient([]),
    prompt: async (_sessionId: string, content: unknown) => { observed.push(content); return 'message-2' },
    subscribeSessionTree: () => fakeClient([
      eventFor('authorized-roots', 'agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      eventFor('authorized-roots', 'turn/start', { turn: 1 }),
      eventFor('authorized-roots', 'assistant/message', { message: { content: [{ type: 'text', text: '收到' }] } }),
      eventFor('authorized-roots', 'turn/end', { reason: { kind: 'completed' } }),
    ]).subscribeSessionTree(),
  }
  Object.assign(runtime, { harness: { start: async () => {}, close: async () => {}, client } })
  await runtime.run({ sessionId: 'authorized-roots', prompt: '生成报告' }, () => {})
  expect(JSON.stringify(observed[0])).toContain('使用 present 声明实际文件')
  expect(JSON.stringify(observed[0])).not.toContain('使用 local_files_publish 登记实际文件')
  await runtime.close()
})

it('reports Harness capability gates without advertising unconfigured providers', async () => {
  const runtime = new DeepSeekHarnessRuntime({ XIAOYIN_ENABLE_SESSION_QUERY_TOOLS: 'false' })
  const health = await runtime.health()
  expect(health.status).toBe('uninitialized')
  expect(health.capabilities).toMatchObject({ profile: 'gated', modelProvider: 'unconfigured', commands: 'enabled', commandFeedback: 'enabled', sessionQuery: 'enabled', sessionQueryTools: 'gated', sessionReference: 'enabled', workspaceChanges: 'enabled', workspaceDependencies: 'unconfigured', officeSkills: 'unconfigured', libreOfficeKit: 'unconfigured', persistentTerminal: 'enabled', lsp: 'unconfigured', codexSubagent: 'unconfigured', present: 'enabled', mcpClient: 'gated', webSearch: 'unconfigured', webFetch: 'unconfigured' })
})

it('reports a configured model provider without exposing its credential', async () => {
  const health = await new DeepSeekHarnessRuntime({ DEEPSEEK_API_KEY: 'test-secret' }).health()
  expect(health.capabilities).toMatchObject({ modelProvider: 'gated', webSearch: 'enabled', webFetch: 'enabled' })
  expect(JSON.stringify(health)).not.toContain('test-secret')
})

it('checks real model generation with fixed synthetic content', async () => {
  const server = createServer((request, response) => {
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/v1/messages')
    expect(request.headers.authorization).toBe('Bearer test-secret')
    expect(request.headers.accept).toBe('text/event-stream')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      expect(JSON.parse(body)).toEqual({ model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }], max_tokens: 16, stream: true, thinking: { type: 'disabled' } })
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const result = await new DeepSeekHarnessRuntime({ DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`, DEEPSEEK_API_KEY: 'test-secret', DSH_MODEL: 'test-model' }).checkProvider()
    expect(result.status).toBe('available')
    expect(result.detail).toBe('模型生成可用')
    expect(result.detail).not.toContain('test-secret')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('rejects an HTTP-success provider response without generated content', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const result = await new DeepSeekHarnessRuntime({ DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`, DEEPSEEK_API_KEY: 'test-secret' }).checkProvider()
    expect(result).toMatchObject({ status: 'unreachable', detail: '模型生成响应无有效内容' })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('does not follow provider redirects with the model credential', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: 'https://unexpected.example/v1/messages' }).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const result = await new DeepSeekHarnessRuntime({ DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`, DEEPSEEK_API_KEY: 'test-secret' }).checkProvider()
    expect(result.status).toBe('unreachable')
    expect(result.detail).not.toContain('test-secret')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('fails fast when the packaged official plugin dependency closure is incomplete', () => {
  expect(() => assertHarnessDependencyClosure()).not.toThrow()
})

it('resolves official plugins nested under the dsh launcher package', () => {
  expect(hasHarnessPackage('@deepseek-ai/dsh-agent-loop')).toBe(true)
  expect(hasHarnessPackage('@deepseek-ai/dsh-api-session-controller')).toBe(true)
  expect(hasHarnessPackage('@deepseek-ai/dsh-package-that-does-not-exist')).toBe(false)
})

it('reports lifecycle state instead of claiming readiness before startup', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  Object.assign(runtime, { harness: { start: async () => {}, close: async () => {}, client: fakeClient([]) } })
  await runtime.initialize()
  expect((await runtime.health()).status).toBe('ready')
  await runtime.close()
  expect((await runtime.health()).status).toBe('uninitialized')
})

it('gates persistent terminal together with desktop shell access', async () => {
  const health = await new DeepSeekHarnessRuntime({ XIAOYIN_ALLOW_SHELL: 'false' }).health()
  expect(health.capabilities).toMatchObject({ shell: 'gated', persistentTerminal: 'gated' })
})

it('keeps official filesystem delivery available when Xiaoyin roots are authorized', async () => {
  const health = await new DeepSeekHarnessRuntime({ XIAOYIN_LOCAL_FILE_ROOTS: '[{"id":"workspace"}]' }).health()
  expect(health.capabilities).toMatchObject({ officialFilesystem: 'enabled', present: 'enabled' })
})

it('reports Office capabilities only when the official Primary Runtime is configured', async () => {
  const health = await new DeepSeekHarnessRuntime({ DSH_BUNDLED_PRIMARY_RUNTIME: '/runtime/primary-runtime' }).health()
  expect(health.capabilities).toMatchObject({ workspaceDependencies: 'enabled', officeSkills: 'enabled', libreOfficeKit: 'enabled' })
})

it('enables the read-only Session Query tools by default', async () => {
  const health = await new DeepSeekHarnessRuntime().health()
  expect(health.capabilities).toMatchObject({ sessionQuery: 'enabled', sessionQueryTools: 'enabled' })
})

it('allows isolating cross-session references without disabling session history', async () => {
  const health = await new DeepSeekHarnessRuntime({ XIAOYIN_ENABLE_SESSION_REFERENCES: 'false' }).health()
  expect(health.capabilities).toMatchObject({ sessionReference: 'gated', sessionQuery: 'enabled' })
})

it('uses the official SQLite Session Query backend for native history search', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xiaoyin-session-query-'))
  try {
    const runtime = new DeepSeekHarnessRuntime({
      DSH_HOME: home,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      XIAOYIN_SESSION_QUERY_PATH: join(home, 'session-query.sqlite'),
    })
    await expect(runtime.searchSessions?.(['session-1'], '库存', 10)).resolves.toEqual({ items: [] })
    await runtime.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('keeps CJK scans independent of a damaged derived index and rebuilds FTS', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xiaoyin-session-query-damaged-'))
  try {
    const queryPath = join(home, 'session-query.sqlite')
    await writeFile(queryPath, 'not a sqlite database')
    const environment = {
      DSH_HOME: home,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      XIAOYIN_SESSION_QUERY_PATH: queryPath,
    }
    const first = new DeepSeekHarnessRuntime(environment)
    const second = new DeepSeekHarnessRuntime(environment)
    try {
      await expect(first.searchSessions?.(['session-1'], '库存', 10)).resolves.toEqual({ items: [] })
      await expect(Promise.all([
        first.searchSessions?.(['session-1'], 'inventory', 10),
        second.searchSessions?.(['session-1'], 'inventory', 10),
      ])).resolves.toEqual([{ items: [] }, { items: [] }])
      expect((await readFile(queryPath)).subarray(0, 15).toString()).toBe('SQLite format 3')
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('never replaces a valid SQLite database owned by another application', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xiaoyin-session-query-foreign-'))
  try {
    const queryPath = join(home, 'session-query.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const database = new DatabaseSync(queryPath)
    database.exec("CREATE TABLE important (value TEXT NOT NULL); INSERT INTO important VALUES ('keep-me')")
    database.close()
    const runtime = new DeepSeekHarnessRuntime({
      DSH_HOME: home,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      XIAOYIN_SESSION_QUERY_PATH: queryPath,
    })
    await expect(runtime.searchSessions?.(['session-1'], 'inventory', 10)).rejects.toThrow(/not an empty or recognized derived index/i)
    const unchanged = new DatabaseSync(queryPath, { readOnly: true })
    try { expect(unchanged.prepare('SELECT value FROM important').get()).toEqual({ value: 'keep-me' }) }
    finally { unchanged.close() }
    await runtime.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('passes an invalid official Session Query cursor through as a typed failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xiaoyin-session-query-cursor-'))
  try {
    const runtime = new DeepSeekHarnessRuntime({
      DSH_HOME: home,
      DSH_SESSION_ROOT: join(home, 'sessions'),
      XIAOYIN_SESSION_QUERY_PATH: join(home, 'session-query.sqlite'),
    })
    await expect(runtime.searchSessions?.(['session-1'], '库存', 10, 'definitely-not-a-provider-cursor')).rejects.toThrow(/cursor|游标/i)
    await runtime.close()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('projects official plugins outside the sdk bundle into an external employee DSH_HOME', async () => {
  const home = await mkdtemp(join(tmpdir(), 'xiaoyin-plugin-fallback-'))
  try {
    await ensureExternalHarnessPlugins({ DSH_HOME: home })
    const packageNames = [
      process.platform === 'win32' ? 'dsh-tool-pwsh-persistent' : 'dsh-tool-bash-persistent',
      'dsh-tool-session-query',
    ]
    for (const packageName of packageNames) {
      const target = join(home, 'profiles', 'node_modules', '@deepseek-ai', packageName)
      const stat = await lstat(target)
      expect(stat.isSymbolicLink() || stat.isDirectory()).toBe(true)
      if (stat.isSymbolicLink()) expect(await readlink(target)).toContain(`@deepseek-ai/${packageName}`)
    }
    await ensureExternalHarnessPlugins({ DSH_HOME: home })
    for (const packageName of packageNames) {
      const target = join(home, 'profiles', 'node_modules', '@deepseek-ai', packageName)
      expect((await lstat(target)).isDirectory() || (await lstat(target)).isSymbolicLink()).toBe(true)
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

it('only advertises LSP when the server map is valid and non-empty', () => {
  expect(hasConfiguredLspServers(undefined)).toBe(false)
  expect(hasConfiguredLspServers('{}')).toBe(false)
  expect(hasConfiguredLspServers('[]')).toBe(false)
  expect(hasConfiguredLspServers('invalid')).toBe(false)
  expect(hasConfiguredLspServers('{"typescript":1}')).toBe(false)
  expect(hasConfiguredLspServers('{"typescript":{"command":"typescript-language-server"}}')).toBe(false)
  expect(hasConfiguredLspServers('{"typescript":{"command":"typescript-language-server","extensionToLanguage":{"ts":"typescript"}}}')).toBe(false)
  expect(hasConfiguredLspServers('{"typescript":{"command":"typescript-language-server","extensionToLanguage":{".ts":"typescript"}}}')).toBe(true)
})

it('keeps LSP unconfigured when the desktop switch is disabled', async () => {
  const runtime = new DeepSeekHarnessRuntime({
    XIAOYIN_ALLOW_LSP: 'false',
    XIAOYIN_LSP_SERVERS: JSON.stringify({ typescript: { command: 'typescript-language-server', extensionToLanguage: { '.ts': 'typescript' } } }),
  })
  expect((await runtime.health()).capabilities?.lsp).toBe('unconfigured')
})

it('keeps configured external agents unconfigured when the desktop switch is disabled', async () => {
  const runtime = new DeepSeekHarnessRuntime({
    XIAOYIN_ALLOW_EXTERNAL_AGENTS: 'false',
    XIAOYIN_ENABLE_CODEX_SUBAGENT: 'true',
    XIAOYIN_ENABLE_CLAUDE_SUBAGENT: 'true',
    XIAOYIN_ACP_COMMAND: 'acp-agent',
    XIAOYIN_ENABLE_DSH_SUBAGENT: 'true',
  })
  expect((await runtime.health()).capabilities).toMatchObject({
    codexSubagent: 'unconfigured', claudeSubagent: 'unconfigured', acpSubagent: 'unconfigured', dshSubagent: 'unconfigured',
  })
})

it('keeps configured hooks unconfigured when the desktop switch is disabled', async () => {
  const runtime = new DeepSeekHarnessRuntime({
    XIAOYIN_ALLOW_HOOKS: 'false',
    XIAOYIN_CODEX_HOOKS_CONFIG: '/tmp/codex-hooks.json',
    XIAOYIN_CLAUDE_HOOKS_CONFIG: '/tmp/claude-hooks.json',
  })
  expect((await runtime.health()).capabilities).toMatchObject({ codexHooks: 'gated', claudeHooks: 'gated' })
})

it('closes the underlying runtime immediately instead of waiting for the active turn', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const close = vi.fn(async () => {})
  Object.assign(runtime, { runTail: new Promise<void>(() => {}), harness: { close } })
  await runtime.close()
  await runtime.close()
  expect(close).toHaveBeenCalledOnce()
  await expect(runtime.initialize()).rejects.toThrow('本轮已停止')
})

it('rejects queued work after shutdown rather than starting another runtime', async () => {
  const runtime = new DeepSeekHarnessRuntime()
  const pending = runtime.run({ prompt: '不应执行' }, () => {})
  await runtime.close()
  await expect(pending).rejects.toThrow('本轮已停止')
})

describe('local cross-session memory', () => {
  it('adds employee guidance without replacing the current task', () => {
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('先给结论')
    expect(applyMemoryContext('分析库存', '先给结论')).toContain('当前任务：\n分析库存')
    expect(applyMemoryContext('分析库存', '')).toBe('分析库存')
  })
})

describe('persisted session follow-ups', () => {
  it('returns only the official turn result and visible assistant response', async () => {
    const result = await runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }), event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '请提供销售明细。' }] } }),
      event('turn/end', { reason: { kind: 'completed' } }),
    ]), 'session-1', [{ type: 'text', text: '分析销售' }], () => {})
    expect(result).toEqual({ sessionId: 'session-1', finalResponse: '请提供销售明细。' })
  })
  it('fails a turn after partial output while still forwarding that output to the desktop', async () => {
    const observed: HarnessNotification[] = []
    const notifications = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '已读取表格，准备核对数据。' }] } }),
      event('turn/end', { reason: { kind: 'error', error: { message: 'model disconnected' } } }),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '处理表格' }], (value) => observed.push(value))).rejects.toThrow()
    expect(JSON.stringify(observed)).toContain('已读取表格')
  })

  it('does not treat reaching the output limit as task completion', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '未写完' }] } }),
      event('turn/end', { reason: { kind: 'max-tokens' } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toThrow('输出上限')
  })

  it.each([
    ['aborted', '已停止'],
    ['blocked', '未进入执行'],
    ['interrupted', '意外中断'],
  ])('does not treat a %s turn as successful', async (kind, message) => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '部分结果' }] } }),
      event('turn/end', { reason: kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toThrow(message)
  })

  it('reports payload-less errors as failures even after a partial response', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '部分结果' }] } }),
      event('turn/end', { reason: { kind: 'error' } }),
    ]), 'session-1', [{ type: 'text', text: '继续' }], () => {})).rejects.toMatchObject({ data: { code: 'XY-MODEL-UNKNOWN', category: 'model', retryable: false } })
  })

  it('does not accept completion while a dispatched tool has no receipt', async () => {
    await expect(runSessionTurn(fakeClient([
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('tool/call', { callId: 'write', name: 'order_create' }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '订单已创建' }] } }),
      event('turn/end', { reason: { kind: 'completed' } }),
    ]), 'session-1', [{ type: 'text', text: '创建订单' }], () => {})).rejects.toThrow('工具操作未取得结果')
  })

  it('stops waiting when a turn never produces activity', async () => {
    const client = {
      prompt: async () => 'message-2',
      subscribeSessionTree: () => ({ next: async () => new Promise<HarnessNotification>(() => undefined), close: () => undefined }),
    }

    await expect(runSessionTurn(client, 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 10))
      .rejects.toThrow('任务执行超过 1 秒')
  })

  it('bounds prompt acknowledgement and closes the subscription when the engine stalls', async () => {
    const close = vi.fn()
    const next = vi.fn()
    const client = {
      prompt: () => new Promise<string>(() => {}),
      subscribeSessionTree: () => ({ next, close }),
    }
    await expect(runSessionTurn(client, 'session-1', [{ type: 'text', text: '继续' }], () => {}, 10))
      .rejects.toThrow('任务执行超过')
    expect(close).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('ignores a stale idle status until the new turn has actually started', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      status('idle'),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '冒泡排序会重复比较相邻元素。' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    const observed: HarnessNotification[] = []
    const result = await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '解释下冒泡' }], (value) => observed.push(value))

    expect(result.finalResponse).toBe('冒泡排序会重复比较相邻元素。')
    expect(observed).toHaveLength(6)
    expect(observed.some((item) => item.params.event?.type === 'text-chunks')).toBe(true)
  })

  it('finishes on turn/end even when the runtime does not emit a trailing idle status', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '完成。' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]

    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 20))
      .resolves.toMatchObject({ finalResponse: '完成。' })
  })

  it('completes a textless model turn without failing the run', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .resolves.toMatchObject({ finalResponse: '' })
  })

  it('surfaces a safe provider failure instead of misreporting an empty answer', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('turn/end', { turn: 2, reason: { kind: 'error', error: {
        message: "Invalid 'tools[24].function.name': expected ^[a-zA-Z0-9_-]+$",
      } } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .rejects.toMatchObject({ data: { code: 'XY-MODEL-UNKNOWN', category: 'model', retryable: false } })
  })

  it('keeps the last visible assistant text when a later tool-only message arrives', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '我先检查文件。' }] } }),
      event('assistant/message', { message: { content: [{ type: 'tool-call', name: 'local_files_list' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined))
      .resolves.toMatchObject({ finalResponse: '我先检查文件。' })
  })

  it('waits for the root turn while forwarding child session activity', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      eventFor('child-1', 'turn/start', { turn: 1 }),
      eventFor('child-1', 'assistant/message', { message: { content: [{ type: 'text', text: '子 Agent 调研结果' }] } }),
      eventFor('child-1', 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      statusFor('child-1', 'idle'),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: '主 Agent 汇总结果' }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
      status('idle'),
    ]
    const observed: HarnessNotification[] = []
    const result = await runSessionTurn(
      fakeClient(notifications),
      'session-1',
      [{ type: 'text', text: '并行调研' }],
      (value) => observed.push(value),
    )

    expect(result.finalResponse).toBe('主 Agent 汇总结果')
    expect(observed.some((item) => item.params.sessionId === 'child-1')).toBe(true)
  })
})

describe('visible response streaming', () => {
  it('forwards live text once, excludes reasoning, and preserves turn and step', async () => {
    const notifications = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/stream', { type: 'start', turn: 2, step: 3 }),
      event('assistant/stream', { type: 'chunk', turn: 2, step: 3, chunk: { type: 'reasoning-delta', text: 'private reasoning' } }),
      event('assistant/stream', { type: 'chunk', turn: 2, step: 3, chunk: { type: 'text-delta', text: 'Hello' } }),
      event('assistant/stream', { type: 'chunk', turn: 2, step: 3, chunk: { type: 'text-delta', text: ' world' } }),
      event('assistant/message', { turn: 2, step: 3, message: { content: [{ type: 'text', text: 'Hello world' }] } }),
      event('turn/end', { reason: { kind: 'completed' } }),
    ]
    const observed: HarnessNotification[] = []
    await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: 'hello' }], value => observed.push(value))
    const chunks = observed.filter(item => item.params.event?.type === 'text-chunks')
    expect(chunks.map(item => item.params.event?.data)).toEqual([
      expect.objectContaining({ turn: 2, step: 3, texts: ['Hello'] }),
      expect.objectContaining({ turn: 2, step: 3, texts: [' world'] }),
    ])
    expect(JSON.stringify(observed)).not.toContain('private reasoning')
  })
  it('forwards complete answers without artificial timers or text fragmentation', async () => {
    const answer = '冒泡排序会反复比较相邻元素，并在顺序错误时交换它们，直到整个序列有序。'
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 2 }),
      event('assistant/message', { message: { content: [{ type: 'text', text: answer }] } }),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }),
    ]
    const observed: HarnessNotification[] = []

    vi.useFakeTimers()
    try {
      await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '冒泡排序是什么' }], (value) => observed.push(value))
      const chunks = observed.filter((item) => item.params.event?.type === 'text-chunks')
      expect(chunks).toHaveLength(1)
      expect(chunks[0].params.event?.data).toMatchObject({ texts: [answer] })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never re-emits a segment when its assistant message lands after a tool call', async () => {
    const notifications: HarnessNotification[] = [
      event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
      event('turn/start', { turn: 1 }),
      event('text-chunks', { turn: 1, step: 1, texts: ['我先检查文件。'] }),
      event('tool/call', { turn: 1, step: 2, callId: 'call-1', name: 'local_files_list' }),
      event('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '我先检查文件。' }] } }),
      event('tool/result', { callId: 'call-1', message: { content: [{ type: 'tool-result', toolCallId: 'call-1' }] } }),
      event('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: '检查完成。' }] } }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    const observed: HarnessNotification[] = []

    const result = await runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '检查文件' }], (value) => observed.push(value))

    const streamed = observed
      .filter((item) => item.params.event?.type === 'text-chunks')
      .map((item) => ((item.params.event?.data ?? {}) as { texts?: string[] }).texts?.join('') ?? '')
      .join('')
    expect(streamed).toBe('我先检查文件。检查完成。')
    expect(result.finalResponse).toBe('检查完成。')
  })
})

function fakeClient(notifications: HarnessNotification[]) {
  let index = 0
  return {
    prompt: async () => 'message-2',
    subscribeSessionTree: () => ({
      next: async () => notifications[index++]!,
      close: () => undefined,
    }),
  }
}

function event(type: string, data: Record<string, unknown>): HarnessNotification {
  return { method: 'session.event', params: { sessionId: 'session-1', event: { type, data } } }
}

function status(value: string): HarnessNotification {
  return { method: 'session.status', params: { sessionId: 'session-1', status: value } }
}

function eventFor(sessionId: string, type: string, data: Record<string, unknown>): HarnessNotification {
  return { method: 'session.event', params: { sessionId, event: { type, data } } }
}

function statusFor(sessionId: string, value: string): HarnessNotification {
  return { method: 'session.status', params: { sessionId, status: value } }
}

it('returns an interrupted flag instead of failing when the employee interrupts an aborted turn', async () => {
  const notifications: HarnessNotification[] = [
    event('agent/inbox/spliced', { inserted: [{ id: 'message-2' }] }),
    event('turn/start', { turn: 2 }),
    event('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '部分结果' }] } }),
    event('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    status('idle'),
  ]
  let interrupted = false
  await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 5_000, () => interrupted))
    .rejects.toThrow('本轮已停止')
  interrupted = true
  await expect(runSessionTurn(fakeClient(notifications), 'session-1', [{ type: 'text', text: '继续' }], () => undefined, 5_000, () => interrupted))
    .resolves.toMatchObject({ finalResponse: '部分结果', interrupted: true })
})
