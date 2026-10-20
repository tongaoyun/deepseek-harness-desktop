/** Company files enter the native catalogs through a real file-backed Loader profile. */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Skills from '@deepseek-ai/dsh-skill'
import Sessions from '@deepseek-ai/dsh-session'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { contentDigest } from '@deepseek-harness/product/company-content'
import * as Agency from '@michengai/dsh-agency-agents'
const AGENCY_LIBRARY_SERVICE = 'agencyAgentsLibrary'
interface AgencyExpertLibrary { catalog(): Promise<{ experts: readonly { slug: string; company?: boolean; division: string }[] }> }
import { installCompanyContent } from '../src/company-content.ts'
import { nativeExtensionPatches } from '../src/native-extensions.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agencyAgentsLibrary: AgencyExpertLibrary; agencyAgentsPersona: Agency.AgencyPersonaSource }
}

it.each([true, false])('loads company skills and experts (published=%s), then withdraws registrations on disposal', async (published) => {
  const home = mkdtempSync(join(tmpdir(), 'company-profile-'))
  onTestFinished(() =>{  rmSync(home, { recursive: true, force: true }) })
  vi.stubEnv('DSH_HOME', home)
  onTestFinished(() => { vi.unstubAllEnvs() })
  const files: Record<string, string> = published ? {
    'skills/company-orders/SKILL.md': Buffer.from('---\nname: company-orders\ndescription: 查询公司订单\n---\nCompany order skill body.').toString('base64'),
    'experts/operations/company-orders.md': Buffer.from('---\nname: 公司订单专家\ndescription: 处理公司订单\n---\nCompany order expert persona.').toString('base64'),
  } : {}
  const release = published ? { version: '1.0.0', sha256: contentDigest(files), files } : null
  const roots = await installCompanyContent(join(home, 'company-content'), 'employee-fixture', release, new AbortController().signal)
  vi.stubEnv('DSH_COMPANY_SKILLS_ROOT', roots.skillsRoot)
  vi.stubEnv('DSH_COMPANY_EXPERTS_ROOT', roots.expertsRoot)
  const directory = join(home, 'profile')
  initProfile(directory, [])
  const rows = [
    { id: 'editor', name: 'cordis:editor' }, { id: 'settings', name: 'cordis:settings' },
    { id: 'tools', name: 'cordis:tools' }, { id: 'prompt', name: 'cordis:prompt' },
    { id: 'skills', name: 'cordis:skills' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'agency-agents', name: '@michengai/dsh-agency-agents' },
    { id: 'manager', name: '@michengai/dsh-skills-manager' },
  ]
  for (const name of ['@michengai/dsh-agency-agents', '@michengai/dsh-skills-manager']) {
    const installed = join(directory, 'node_modules', name)
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name, version: '1.2.8', type: 'module', exports: './index.js' }))
    writeFileSync(join(installed, 'index.js'), 'throw new Error("profile-installed community plugin must not load")\n')
  }
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  const bundled = nativeExtensionPatches({ directory, installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)) })
  // The remote entry is covered by desktop startup; this catalog fixture supplies no remote registry.
  const patches = bundled.filter(patch => !('insert' in patch))
  writeFileSync(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }, ...patches]))
  writeFileSync(join(directory, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = { name: 'test', startedBundles: [], dir: directory,
    patchPath: join(directory, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
  const ctx = await boot('test', join(directory, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    // This case observes catalogs and does not execute or mock a model or a delegated task.
    ctx.provide('subagents', {})
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, tools: Tools, prompt: SystemPrompt,
      skills: Skills, sessions: Sessions, web: WebServer })
  })
  onTestFinished(() => ctx.fiber.dispose())
  const library = ctx.get(AGENCY_LIBRARY_SERVICE)
  expect(library).toBeDefined()
  const catalog = await library!.catalog()
  const expert = catalog.experts.find(expert => expert.slug === 'company-orders')
  expect(expert?.company).toBe(published ? true : undefined)
  if (published) {
    expect(expert?.division).toBe('operations')
    const persona = ctx.get(Agency.AGENCY_PERSONA_SERVICE)
    expect((await persona!.getPrompt('company-orders', 'operations', 'zh')).prompt).toContain('Company order expert persona.')
  }
  expect((await ctx.skills.list()).some(skill => skill.name === 'company-orders')).toBe(published)
  if (published) expect((await ctx.skills.get('company-orders'))?.content).toContain('Company order skill body.')
  await ctx.loader.root.update([])
  await ctx.loader.await()
  expect(ctx.get(AGENCY_LIBRARY_SERVICE)).toBeUndefined()
})
