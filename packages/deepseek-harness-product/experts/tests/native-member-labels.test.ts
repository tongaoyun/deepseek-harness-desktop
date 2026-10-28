// @vitest-environment jsdom
/** Actual DOM recycling and asynchronous label ownership. */
import { afterEach, expect, it, vi } from 'vitest'
import { installNativeTeamNames } from '../src/client/native-team-names.ts'

const identity = 'agency-engineering-software-architect-8a70fbbcd3'
const handles: ReturnType<typeof installNativeTeamNames>[] = []
afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose()
  document.body.replaceChildren()
})
function roster(original = 'lead') {
  document.body.innerHTML = `<div class="native_roster"><button><span class="native_memberText"><span class="native_memberName"><span class="native_memberNameText"></span></span></span></button></div>
    <div class="native_taskTitle"><strong>技术方案评审团: 软件架构师</strong></div>
    <div class="native_tasks"><span>Owner: ${identity}</span></div>`
  const leaf = document.querySelector('.native_memberNameText')!
  const text = document.createTextNode(original)
  leaf.append(text)
  return text
}
const labels = () => ({ members: new Map([[identity, '软件架构师']]),
  teams: [{ names: ['技术方案评审团'], label: '技术方案评审团' }] })
function install(load = async () => labels(), onError = vi.fn()) {
  const handle = installNativeTeamNames(load, onError)
  handles.push(handle)
  return handle
}

it('stops treating a reused leader text node as the previous leader', async () => {
  const text = roster()
  const handle = install()
  await handle.refresh()
  expect(text.data).toBe('技术方案评审团')
  text.data = identity
  await vi.waitFor(() => { expect(text.data).toBe('软件架构师') })
  text.data = '外部审查员'
  await handle.refresh()
  expect(text.data).toBe('外部审查员')
  handle.dispose()
  expect(text.data).toBe('外部审查员')
  expect(document.querySelector('.native_tasks')!.textContent).toBe(`Owner: ${identity}`)
})

it('preserves leader whitespace and restores it when the matching task title disappears', async () => {
  const text = roster('  lead  ')
  const handle = install()
  await handle.refresh()
  expect(text.data).toBe('  技术方案评审团  ')
  document.querySelector('strong')!.textContent = '其他任务: 审核'
  await vi.waitFor(() => { expect(text.data).toBe('  lead  ') })
  handle.dispose()
  expect(text.data).toBe('  lead  ')
})

it('ignores obsolete reads and retains host edits during teardown', async () => {
  const text = roster(identity)
  const reads: ReturnType<typeof Promise.withResolvers<ReturnType<typeof labels>>>[] = []
  const load = vi.fn(() => {
    const read = Promise.withResolvers<ReturnType<typeof labels>>()
    reads.push(read)
    return read.promise
  })
  const error = vi.fn()
  const handle = install(load, error)
  const latest = handle.refresh()
  const current = reads.at(-1)!
  current.resolve(labels())
  await latest
  expect(text.data).toBe('软件架构师')
  for (const read of reads) if (read !== current) read.reject(new Error('Old failure'))
  await Promise.resolve()
  expect(error).not.toHaveBeenCalled()
  text.data = '宿主刚修改的名称'
  handle.dispose()
  expect(text.data).toBe('宿主刚修改的名称')
  const calls = load.mock.calls.length
  await handle.refresh()
  expect(load).toHaveBeenCalledTimes(calls)
})

it('restores only the name leaf it owns when disposed', async () => {
  const text = roster(identity)
  const handle = install()
  await handle.refresh()
  expect(text.data).toBe('软件架构师')
  handle.dispose()
  expect(text.data).toBe(identity)
})
