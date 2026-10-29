/** Locale projection through real profile composition, Loader and Settings. */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, reconcileProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as Locale from '@deepseek-ai/dsh-client-locale'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createHostLocaleReader, readHostLocale, type LocaleId } from '../src/i18n.ts'
import { localizeTeamTool } from '../src/team-tool-locale.ts'

it('follows late locale activation and persisted language changes without rereading Settings per schema', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'expert-native-locale-')))
  const owner: { ctx?: Context } = {}
  onTestFinished(async () => {
    await owner.ctx?.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'locale-test')
  initProfile(dir, ['locale-test-bundle'])
  const bundle = join(dir, 'node_modules', 'locale-test-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"expert-locale-test"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'locale-test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'locale-consumer', name: 'cordis:consumer' },
    { id: 'locale', name: 'cordis:locale', disabled: true, config: { preference: 'zh' } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'locale-test', startedBundles: ['locale-test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  let readLocale: () => LocaleId = () => 'en'
  const ctx = owner.ctx = await boot('locale-test', join(dir, 'cordis.yml'), readProfilePatches('locale-test', profile), (scope) => {
    scope.provide('profileContext', profile)
    scope.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(scope.loader.builtins, {
      editor: ConfigEditor, settings: Settings, locale: Locale,
      consumer: { inject: ['settings'], apply(child: Context) { readLocale = createHostLocaleReader(child) } },
    })
  })
  expect(readLocale()).toBe('en')
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'locale')
  if (!entry) throw new Error('Locale entry missing')
  await writeFile(profile.patchPath, JSON.stringify([{ id: 'locale', disabled: false }]))
  await reconcileProfilePatches(ctx, readProfilePatches('locale-test', profile), 'locale-test')
  await entry.fiber?.await()
  await vi.waitFor(() => { expect(readLocale()).toBe('zh') })
  const tool = localizeTeamTool(defineTool({
    name: 'list_expert_teams', description: '列出已启用专家团。召唤前使用 get_expert_team 读取主理人规则及成员分工。', parameters: {},
    output: { schema: { type: 'string' }, render: () => [] }, execute: async () => '',
  }), readLocale)
  const chinese = tool.description
  const reads = vi.spyOn(ctx.settings, 'describe')
  for (let index = 0; index < 76; index++) expect(tool.description).toBe(chinese)
  expect(reads).not.toHaveBeenCalled()
  await ctx.settings.update('locale', { preference: 'en' })
  await vi.waitFor(() => { expect(readLocale()).toBe('en') })
  expect(readHostLocale(ctx)).toBe('en')
  const english = tool.description
  expect({ chinese, english }).toMatchSnapshot()
  const consumer = [...ctx.loader.entries()].find(row => row.options.id === 'locale-consumer')
  if (!consumer?.fiber) throw new Error('Locale consumer missing')
  const stoppedReadLocale = readLocale
  await consumer.fiber.dispose()
  reads.mockClear()
  await ctx.settings.update('locale', { preference: 'zh' })
  await Promise.resolve()
  const readsAfterWrite = reads.mock.calls.length
  expect(stoppedReadLocale()).toBe('en')
  await Promise.resolve()
  expect(reads).toHaveBeenCalledTimes(readsAfterWrite)
})
