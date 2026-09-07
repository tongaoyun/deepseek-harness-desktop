import { beforeEach, expect, it, vi } from 'vitest'
import { automaticMemoryCandidate, emptyMemoryProfile, forgetInstruction, learnCompletedTask, loadSyncedMemoryProfile, parseMemoryCommand, rememberInstruction, saveSyncedMemoryProfile, syncMemoryProfile, resolveMemoryConflict, changeMemoryEntry, upsertMemoryEntry, validateMemoryProfile, type MemoryProfile } from './memory'

let stored: MemoryProfile
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: async (command: string, args: { profile: MemoryProfile }) => {
  if (command === 'load_memory_profile') return structuredClone(stored)
  if (command === 'save_memory_profile') { stored = structuredClone(args.profile); return stored }
  return []
} }))
beforeEach(() => { stored = { ...emptyMemoryProfile, entries: [], automaticMemory: true }; vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))) })

it('understands explicit natural commands without guessing ambiguous references', () => {
  expect(parseMemoryCommand('请记住我偏好中文。')).toEqual({ action: 'remember', text: '我偏好中文' })
  expect(parseMemoryCommand('忘记：我偏好中文')).toEqual({ action: 'forget', text: '我偏好中文' })
  expect(parseMemoryCommand('记住这个')).toBeUndefined()
  expect(parseMemoryCommand('忘记刚才说的')).toEqual({ action: 'forget', text: '刚才说的' })
})
it('blocks stale cloud writes, keeps local changes, and resumes only after an explicit version choice', async () => {
  stored = { ...emptyMemoryProfile, entries: [], collaborationStyle: '本机修改', version: 2, syncPending: true, updatedAt: '2026-09-07' }
  const cloud = { ...stored, collaborationStyle: '另一台修改', version: 3, syncPending: false }
  vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === 'PUT' ? new Response(JSON.stringify(wire({})), { status: 409 }) : new Response(JSON.stringify(wire(cloud))))
  const conflict = await syncMemoryProfile('u', '/memory', '')
  expect(conflict.syncConflict).toBe(true)
  expect(conflict.collaborationStyle).toBe('本机修改')
  vi.mocked(fetch).mockClear()
  await syncMemoryProfile('u', '/memory', '')
  expect(fetch).not.toHaveBeenCalled()
  const resolved = await resolveMemoryConflict('u', '/memory', '', false, conflict.updatedAt)
  expect(resolved).toMatchObject({ collaborationStyle: '另一台修改', version: 3, syncConflict: false, syncPending: false })
})
it('recognizes an already committed timed-out save without overwriting cloud again', async () => {
  stored = { ...emptyMemoryProfile, version: 2, syncPending: true }
  vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === 'PUT' ? new Response(JSON.stringify(wire({})), { status: 409 }) : new Response(JSON.stringify(wire({ ...stored, version: 3 }))))
  expect(await syncMemoryProfile('u', '/memory', '')).toMatchObject({ version: 3, syncPending: false, syncConflict: false })
})
it('rejects modification if a selected candidate changed before confirmation', async () => {
  stored = upsertMemoryEntry(emptyMemoryProfile, '默认用美元', '用户', 'task')
  const selected = structuredClone(stored.entries![0])
  stored.entries![0].text = '默认用人民币'
  await expect(changeMemoryEntry('u', '/memory', '', selected, '默认用欧元')).rejects.toThrow('已更新')
  expect(stored.entries![0].text).toBe('默认用人民币')
})
it('only learns explicitly stated lasting preferences', () => {
  expect(automaticMemoryCandidate('以后请先给结论')).toBe('以后请先给结论')
  for (const text of ['这次先给结论', '我偏好中文，比如这次报告', '以后请记住密码 abc', '我习惯“某个规则”', '模型认为我喜欢中文']) expect(automaticMemoryCandidate(text)).toBeUndefined()
})
it('deduplicates and validates entries before storage', () => {
  const once = upsertMemoryEntry(emptyMemoryProfile, '中文', '用户', 'task')
  expect(upsertMemoryEntry(once, '中文', '用户', 'task')).toBe(once)
  expect(() => validateMemoryProfile({ ...once, entries: [once.entries![0], once.entries![0]] })).toThrow()
  expect(() => validateMemoryProfile({ ...once, entries: [{ ...once.entries![0], text: '' }] })).toThrow()
})
it('preserves offline changes including deletions instead of restoring remote content', async () => {
  const saved = await rememberInstruction('u', '/memory', '', '库存规则', 'task-1')
  expect(saved.syncPending).toBe(true)
  expect(saved.entries?.[0].taskId).toBe('task-1')
  const cleared = await forgetInstruction('u', '/memory', '', '库存规则')
  expect(cleared.entries).toEqual([])
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(wire({ ...saved, updatedAt: '2099-01-01' }))))
  expect((await loadSyncedMemoryProfile('u', '/memory', '')).entries).toEqual([])
})
it('serializes simultaneous learning without losing either entry', async () => {
  await Promise.all([learnCompletedTask('u', '/memory', '', '以后请用中文', 'one'), learnCompletedTask('u', '/memory', '', '我习惯先看结论', 'two')])
  expect(stored.entries).toHaveLength(2)
  const stale = { ...stored }
  await rememberInstruction('u', '/memory', '', '新增规则')
  await expect(saveSyncedMemoryProfile('u', '/memory', '', stale)).rejects.toThrow('其他任务更新')
})
it('does not learn when automatic memory or all memory is disabled', async () => {
  stored.automaticMemory = false
  expect(await learnCompletedTask('u', '/memory', '', '以后请用中文', 'one')).toBeUndefined()
  stored.automaticMemory = true; stored.enabled = false
  expect(await learnCompletedTask('u', '/memory', '', '以后请用中文', 'one')).toBeUndefined()
  expect(stored.entries).toEqual([])
})
it('retries sync without leaking local sync flags and requires a valid response', async () => {
  const saved = await rememberInstruction('u', '/memory', '', '中文')
  vi.mocked(fetch).mockImplementation(async (_url, options) => new Response(JSON.stringify(wire({ ...JSON.parse(options?.body as string), updatedAt: '2099-01-01T00:00:00Z' }))))
  const synced = await saveSyncedMemoryProfile('u', '/memory', '', saved)
  expect(synced.syncPending).toBe(false)
  const options = vi.mocked(fetch).mock.calls.at(-1)![1]!
  expect(options.signal).toBeInstanceOf(AbortSignal)
  expect(JSON.parse(options.body as string).syncPending).toBeUndefined()
})

function wire(data: unknown) { return { success: true, data } }
