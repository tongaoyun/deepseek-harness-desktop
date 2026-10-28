/** Company files enter the native catalogs through a real file-backed Loader profile. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Skills from '@deepseek-ai/dsh-skill'
import Sessions from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query-sqlite'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Typert from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import Access from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { contentDigest } from '@deepseek-harness/product/company-content'
import * as Agency from '@deepseek-harness/product-experts'
const AGENCY_LIBRARY_SERVICE = 'agencyAgentsLibrary'
interface AgencyExpertLibrary {
  catalog(): Promise<{
    experts: readonly { slug: string; name: string; company?: boolean; custom?: boolean; division: string; conflict?: boolean }[]
    revision: number
    enabled: string[]
  }>
  saveCustom(input: { name: string; description: string; division: string; prompt: string }, enabled: boolean, revision: number): ReturnType<AgencyExpertLibrary['catalog']>
}
import { installCompanyContent } from '../src/company-content.ts'
import { builtinCapabilityPatches } from '../src/builtin-capabilities.ts'
import { CompanyContent } from '@deepseek-harness/product-runtime/company-content'
import { CompanyContentSync } from '../src/company-content-sync.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agencyAgentsLibrary: AgencyExpertLibrary; agencyAgentsPersona: Agency.AgencyPersonaSource }
}

it.each([{ published: false, refresh: false, collision: false }, { published: true, refresh: false, collision: false }, { published: true, refresh: true, collision: false }, { published: true, refresh: false, collision: true }])('loads native company catalogs and isolates refreshed content (%j)', async ({ published, refresh, collision }) => {
  const home = mkdtempSync(join(tmpdir(), 'company-profile-'))
  onTestFinished(() =>{  rmSync(home, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const files: Record<string, string> = published ? {
    'skills/orders/SKILL.md': Buffer.from('---\nname: orders\ndescription: 查询公司订单\n---\nCompany order skill body.').toString('base64'),
    'experts/operations/orders.md': Buffer.from('---\nname: 公司订单专家\ndescription: 处理公司订单\n---\nCompany order expert persona.').toString('base64'),
  } : {}
  if (published) {
    files['experts/operations/long-header.md'] = Buffer.from(
      `---\nname: Long published expert\ndescription: ${'a'.repeat(70 * 1024)}\n---\nPublished long-header persona.`).toString('base64')
  }
  if (collision) {
    for (const [slug, name] of [['chief-executive-officer', '冲突公司专家'], ['duplicate-one', '同名专家'], ['duplicate-two', '同名专家']]) {
      files[`experts/operations/${slug}.md`] = Buffer.from(`---\nname: ${name}\ndescription: 冲突专家\n---\nMust not execute.`).toString('base64')
    }
  }
  const release = published ? { version: '1.0.0', sha256: contentDigest(files), files } : null
  const roots = await installCompanyContent(join(home, 'company-content'), 'employee-fixture', release, new AbortController().signal)
  let remote: unknown = release
  let now = performance.now()
  if (refresh) {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    onTestFinished(() => { vi.restoreAllMocks() })
  }
  const sync = new CompanyContentSync({ root: join(home, 'company-content'), employeeId: 'employee-fixture', refreshIntervalMs: 1000,
    load: async () => remote })
  onTestFinished(() => sync.close())
  await sync.prepare(); await sync.refresh()
  vi.stubEnv('DSH_COMPANY_SKILLS_ROOT', roots.skillsRoot)
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', roots.expertsRoot)
  const directory = join(home, 'profile')
  initProfile(directory, [])
  const rows = [
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'tools', name: 'cordis:tools' }, { id: 'prompt', name: 'cordis:prompt' },
    { id: 'skills', name: 'cordis:skills' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'query', name: 'cordis:query', config: { path: ':memory:', openAt: 'never' } },
    { id: 'projections', name: 'cordis:projections' }, { id: 'llm', name: 'cordis:llm' },
    { id: 'agents', name: 'cordis:agents' }, { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'company', name: 'cordis:company' },
    { id: 'typert', name: 'cordis:typert' }, { id: 'access', name: 'cordis:access' }, { id: 'gateway', name: 'cordis:gateway' },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
  ]
  const capabilities = builtinCapabilityPatches()
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }, ...capabilities]))
  writeFileSync(join(directory, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: [], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  let pinCount = 0
  let holdPins = false
  const pendingPins: AbortSignal[] = []
  const ctx = await boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    // Cancellation must stop before a delegated task can start.
    ctx.provide('subagents', { getProvider: () => ({ capabilities: {} }), start: async () => { throw new Error('Unexpected delegated task') } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, tools: Tools, prompt: SystemPrompt,
      skills: Skills, sessions: Sessions, web: WebServer, typert: Typert, gateway: Gateway, access: Access,
      query: SessionQuery, projections: SessionProjections,
      llm: Llm, agents: Agents, loop: AgentLoop, company: { inject: ['sessions', 'sessionQuery', 'systemPrompt'], apply(owner: Context) {
        new CompanyContent(owner, { invoke: async (method, payload, signal) => {
          if (method === 'runtime.companyContent.read') return sync.read()
          if (method === 'runtime.companyContent.refresh') { await sync.refresh(); return sync.read() }
          if (method === 'runtime.companyContent.pin' && payload && typeof payload === 'object' && 'sessionId' in payload
            && typeof payload.sessionId === 'string' && 'started' in payload && typeof payload.started === 'boolean') {
            pinCount++
            if (holdPins) {
              if (!signal) throw new Error('Company pin requires cancellation')
              pendingPins.push(signal)
              return new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  const reason: unknown = signal.reason
                  reject(reason instanceof Error ? reason : new Error('Company pin cancelled', { cause: reason }))
                }, { once: true })
                signal.throwIfAborted()
              })
            }
            return sync.pin({ sessionId: payload.sessionId, started: payload.started,
              ...'parentSessionId' in payload && typeof payload.parentSessionId === 'string' ? { parentSessionId: payload.parentSessionId } : {} }, signal)
          }
          throw new Error(`Unexpected company operation: ${method}`)
        } })
      } } })
  })
  onTestFinished(() => ctx.fiber.dispose())
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const invoke = (method: string, args: Record<string, unknown>) => ctx.typertGateway.invoke({
    namespace: 'skillsManager', method, args, peer, signal: AbortSignal.timeout(5_000),
  })
  const library = ctx.get(AGENCY_LIBRARY_SERVICE)
  expect(library).toBeDefined()
  const catalog = await library!.catalog()
  const expert = catalog.experts.find(expert => expert.slug === 'orders')
  expect(expert?.company).toBe(published ? true : undefined)
  if (!published) expect(catalog.experts).toEqual([])
  if (published) {
    expect(catalog.experts.every(expert => expert.company)).toBe(true)
    expect(catalog.experts.find(expert => expert.slug === 'long-header')?.company).toBe(true)
    expect(expert?.division).toBe('operations')
    const persona = ctx.get(Agency.AGENCY_PERSONA_SERVICE)
    expect((await persona!.getPrompt('orders', 'operations', 'zh')).prompt).toContain('Company order expert persona.')
  }
  if (collision) {
    const conflicts = catalog.experts.filter(expert => expert.conflict)
    expect(catalog.experts.filter(expert => expert.slug === 'chief-executive-officer')).toHaveLength(1)
    expect(catalog.experts.find(expert => expert.slug === 'chief-executive-officer')).toMatchObject({ name: '冲突公司专家', conflict: false })
    expect(conflicts.map(expert => expert.slug)).toEqual(expect.arrayContaining(['duplicate-one', 'duplicate-two']))
    const persona = ctx.get(Agency.AGENCY_PERSONA_SERVICE)!
    for (const expert of conflicts) await expect(persona.getPrompt(expert.slug, expert.division, 'zh')).rejects.toThrow()
    const healthy = catalog.experts.find(expert => expert.slug === 'orders')!
    expect((await persona.getPrompt(healthy.slug, healthy.division, 'zh')).prompt.length).toBeGreaterThan(0)
  }
  const skillCatalog = z.object({ roots: z.array(z.object({ key: z.string(), localeKey: z.string().optional(),
    skills: z.array(z.object({ name: z.string() })) })) }).parse(await invoke('readState', { scope: {}, refreshCompany: false }))
  expect(skillCatalog.roots.find(root => root.key === 'company')).toMatchObject({ localeKey: 'company',
    skills: published ? [expect.objectContaining({ name: 'orders' })] : [] })
  expect((await ctx.skills.list()).some(skill => skill.name === 'orders')).toBe(published)
  if (published) expect((await ctx.skills.get('orders'))?.content).toContain('Company order skill body.')
  if (published) {
    for (const [name, flags, invocation] of [
      ['policy-manual-only', 'disable-model-invocation: true', { modelInvocable: false, userInvocable: true }],
      ['policy-model-only', 'user-invocable: false', { modelInvocable: true, userInvocable: false }],
      ['policy-invalid', 'disable-model-invocation: invalid', { modelInvocable: false, userInvocable: false }],
    ] as const) {
      const markdown = `---\nname: ${name}\ndescription: Invocation policy test\n${flags}\n---\nPolicy body.`
      await invoke('uploadSkill', { request: { entries: [{ path: `${name}/SKILL.md`, data: Buffer.from(markdown).toString('base64') }] } })
      await invoke('setSkillEnabled', { target: { root: 'dsh', name }, enabled: true })
      expect((await ctx.skills.list()).find(skill => skill.name === name)?.invocation).toEqual(invocation)
      await invoke('setSkillEnabled', { target: { root: 'dsh', name }, enabled: false })
      expect((await ctx.skills.list()).find(skill => skill.name === name)?.invocation)
        .toEqual({ modelInvocable: false, userInvocable: false })
      await invoke('setSkillEnabled', { target: { root: 'dsh', name }, enabled: true })
      expect((await ctx.skills.list()).find(skill => skill.name === name)?.invocation).toEqual(invocation)
    }
    const snapshot = z.object({ roots: z.array(z.object({ key: z.string(),
      skills: z.array(z.object({ name: z.string(), enabled: z.boolean().optional(), effectiveModelInvocable: z.boolean() })),
    })) }).parse(await invoke('readState', { scope: {}, refreshCompany: false }))
    expect(snapshot.roots.find(root => root.key === 'dsh')?.skills.find(skill => skill.name === 'policy-manual-only'))
      .toMatchObject({ enabled: true, effectiveModelInvocable: false })
  }
  if (published && !refresh) {
    const task = await ctx.agents.create({ sessionId: SessionId('cancel-company-plugin'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    onTestFinished(() => task.dispose())
    const persona = ctx.get(Agency.AGENCY_PERSONA_SERVICE)!
    const beforeRead = pinCount
    expect((await persona.getPrompt('orders', 'operations', 'zh', task.agent.id)).prompt).toContain('Company order expert persona.')
    expect(pinCount - beforeRead).toBe(1)
    const actions: Record<string, (signal: AbortSignal) => Promise<unknown>> = {
      'skill-list': signal => ctx.skills.list({ scope: task.agent, signal }),
      'skill-read': signal => ctx.skills.get('orders', { scope: task.agent, signal }),
      'expert-persona': signal => persona.getPrompt('orders', 'operations', 'zh', task.agent.id, signal),
      ...Object.fromEntries(['list_experts', 'summon_expert', 'summon_expert_team'].map(name => [name,
        (signal: AbortSignal) => ctx.tools.execute({ name, signal, agent: task.agent, callId: ToolCallId(`cancel-${name}`),
          arguments: name === 'list_experts' ? {} : name === 'summon_expert' ? { expert: 'orders', task: 'fixture' } : { team: 'fixture', task: 'fixture' } }),
      ])),
    }
    for (const [name, action] of Object.entries(actions)) {
      holdPins = false
      if (name === 'skill-read') await ctx.skills.list({ scope: task.agent })
      if (name === 'skill-list') {
        const dispose = ctx.skills.registerProvider(() => ({ name: 'cancel-fixture-revision', list: async () => [], get: async () => undefined }))
        dispose()
      }
      holdPins = true
      const controller = new AbortController()
      const stopped = new Error(`Stopped ${name}`)
      let settled = false
      const result = action(controller.signal).catch((error: unknown) => error).finally(() => { settled = true })
      try {
        await vi.waitFor(() => { expect(pendingPins).toHaveLength(1) }, { timeout: 5_000 })
        controller.abort(stopped)
        await vi.waitFor(() => { expect(pendingPins[0]?.aborted, name).toBe(true); expect(settled, name).toBe(true) })
        await result
      } finally {
        controller.abort(stopped)
        pendingPins.length = 0
      }
    }
    holdPins = false
    expect((await ctx.skills.get('orders', { scope: task.agent }))?.content).toContain('Company order skill body.')
    await task.dispose()
  }
  if (refresh) {
    const old = await ctx.agents.create({ sessionId: SessionId('old-company-task'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    onTestFinished(() => old.dispose())
    const source = ctx.get('companyContent')!
    const before = await source.forSession(old.agent.session.id)
    expect((await ctx.skills.get('orders', { scope: old.agent }))?.content).toContain('Company order skill body.')
    const next = { ...files,
      'skills/orders/SKILL.md': Buffer.from('---\nname: orders\ndescription: updated orders\n---\nSecond company skill.').toString('base64'),
      'experts/operations/orders.md': Buffer.from('---\nname: 公司订单专家\ndescription: updated orders\n---\nSecond company expert.').toString('base64'),
    }
    remote = { version: '2.0.0', sha256: contentDigest(next), files: next }
    now += 2000
    await source.refresh()
    expect((await library!.catalog()).experts.find(expert => expert.slug === 'orders')?.company).toBe(true)
    const persona = ctx.get(Agency.AGENCY_PERSONA_SERVICE)!
    expect((await persona.getPrompt('orders', 'operations', 'zh')).prompt).toContain('Second company expert.')
    expect((await persona.getPrompt('orders', 'operations', 'zh', old.agent.session.id)).prompt).toContain('Company order expert persona.')
    const fresh = await ctx.agents.create({ sessionId: SessionId('fresh-company-task'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    onTestFinished(() => fresh.dispose())
    expect((await ctx.skills.get('orders', { scope: fresh.agent }))?.content).toContain('Second company skill.')
    expect((await ctx.skills.get('orders', { scope: old.agent }))?.content).toContain('Company order skill body.')
    const oldPrompt = await ctx.systemPrompt.assemble({ scope: old.agent })
    const freshPrompt = await ctx.systemPrompt.assemble({ scope: fresh.agent })
    expect(JSON.stringify(oldPrompt)).toContain(before.sha256)
    expect(JSON.stringify(freshPrompt)).toContain(contentDigest(next))
    await fresh.dispose(); await old.dispose()
  }
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.get(AGENCY_LIBRARY_SERVICE)).toBeUndefined()
}, 30_000)

it('restores personal experts through the builtin profile and official Settings after restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'builtin-personal-profile-'))
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const directory = join(home, 'profile')
  initProfile(directory, [])
  writeFileSync(join(directory, 'cordis.yml'), '[]\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
      { id: 'tools', name: 'cordis:tools' }, { id: 'prompt', name: 'cordis:prompt' },
      { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } }] },
  ]))
  const profile: ProfileContext = { name: 'test', startedBundles: [], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: home, home, overlays: builtinCapabilityPatches().map(patch => ({ ...patch, insert: patch.insert.filter(entry => entry.id === 'agency-agents') })), telemetryDisabledEnv: undefined }
  const start = () => boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('subagents', { getProvider: () => ({ capabilities: {} }) })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, tools: Tools, prompt: SystemPrompt, web: WebServer })
  })
  const first = await start()
  onTestFinished(() => first.fiber.dispose())
  await first.loader.await()
  expect(first.settings.describe().find(item => item.ns === 'agency-agents')?.autoGenerate).toBe(false)
  const library = first.get(AGENCY_LIBRARY_SERVICE)
  if (!library) throw new Error('Builtin expert library missing')
  const before = await library.catalog()
  const saved = await library.saveCustom({ name: '个人审查专家', description: 'review fixture', division: 'engineering', prompt: 'Personal review instructions.' }, true, before.revision)
  await first.fiber.dispose()
  const second = await start()
  onTestFinished(() => second.fiber.dispose())
  await second.loader.await()
  expect(second.settings.describe().find(item => item.ns === 'agency-agents')?.autoGenerate).toBe(false)
  const restored = await second.get(AGENCY_LIBRARY_SERVICE)?.catalog()
  expect(restored).toMatchObject({ experts: saved.experts, enabled: saved.enabled })
  const expert = saved.experts.find((item: { custom?: boolean }) => item.custom)
  if (!expert) throw new Error('Saved personal expert missing')
  expect((await second.get(Agency.AGENCY_PERSONA_SERVICE)?.getPrompt(expert.slug, 'engineering', 'zh'))?.prompt).toContain('Personal review instructions.')
})
