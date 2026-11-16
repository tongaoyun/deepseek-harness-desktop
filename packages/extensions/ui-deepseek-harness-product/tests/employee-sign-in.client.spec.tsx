// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { DINGTALK_AUTHORIZATION_TIMEOUT_MS } from '@deepseek-harness/product/protocol'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { TaskLibraryInput } from '../src/client/TaskLibraryInput.tsx'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ConnectorsPanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { createEmployeeSignInActions } from '../src/client/employee-sign-in.ts'
import { EmployeeContent } from '../src/client/EmployeeContent.tsx'
import { en, zh } from '../src/locales.ts'

const contexts: Context[] = []
afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})
const t = makeTranslate(zh, commonZh)

async function renderAfterInitialPrompt(node: ReactNode) {
  const view = render(node)
  await act(async () => {})
  const prompt = screen.queryByRole('dialog', { name: zh.authTitle })
  if (prompt) fireEvent.click(within(prompt).getByRole('button', { name: zh.cancel }))
  return view
}
function unusedSlot(): never { throw new Error('Employee sign-in does not read this slot') }
const actions = {
  useContextMenu: contextMenuHook(),
  usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
  useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
  useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: (() => null),
}

function fixture() {
  type Session = { authenticated: boolean; employeeId?: string; displayName?: string }
  let session: Session = { authenticated: false }
  const listeners = new Set<(event: { type: string; payload?: unknown }) => void>()
  const requests: { id: string; timeout?: number }[] = []
  const cancel = vi.fn()
  const getSession = vi.fn(async () => session)
  const resources = vi.fn(async (method: string): Promise<unknown> => method === 'library.list' || method === 'library.files.list'
    ? { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 } : [])
  const changeSession = (value: Session) => {
    session = value
    for (const listener of listeners) listener({ type: 'session.changed', payload: value })
  }
  const authorize = vi.fn(async (): Promise<unknown> => {
    changeSession({ authenticated: true, employeeId: 'private-employee', displayName: '测试员工' })
    return session
  })
  vi.stubGlobal('dshDesktop', { extensions: {
    invoke: async (_namespace: string, method: string, _payload?: unknown, requestId?: string, timeout?: number) => {
      try {
        if (method === 'auth.getSession') return { ok: true, result: await getSession() }
        if (method === 'auth.ensureDingTalk') {
          if (!requestId) throw new Error('Missing authorization request ID')
          requests.push({ id: requestId, ...timeout === undefined ? {} : { timeout } })
          return { ok: true, result: await authorize() }
        }
        return { ok: true, result: await resources(method) }
      } catch (error) { return { ok: false, failure: productFailure(error) } }
    },
    cancel: (_namespace: string, requestId: string) => { cancel(requestId) },
    subscribe: (_namespace: string, listener: (event: { type: string; payload?: unknown }) => void) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
  } })
  const ctx = new Context()
  contexts.push(ctx)
  const employeeSignIn = createEmployeeSignInActions(ctx)
  const tree = (catalog?: 'connectors' | 'library', translate = t, wide = true) => <>
    <DeepSeekHarnessSettingsMenu {...actions} {...employeeSignIn} t={translate} wide={wide}
      settingsOpen={false} openSettings={vi.fn()} openOnboarding={vi.fn()} />
    {catalog && <EmployeeContent t={translate}>{catalog === 'library'
      ? <LibraryPanel {...actions} t={translate} />
      : <ConnectorsPanel {...actions} t={translate} />}</EmployeeContent>}
  </>
  return { tree, requests, cancel, getSession, resources, authorize, changeSession, employeeSignIn,
    requireSignIn: () => { for (const listener of listeners) listener({ type: 'auth.required' }) },
    refreshCatalog: () => { for (const listener of listeners) listener({ type: 'catalog.changed' }) } }
}

it('automatically shows one shared login prompt before starting browser authorization', async () => {
  const f = fixture()
  const view = render(f.tree('library'))
  const dialog = await screen.findByRole('dialog', { name: zh.authTitle })
  expect(f.authorize).not.toHaveBeenCalled()
  expect(f.resources).not.toHaveBeenCalled()
  act(() => { f.requireSignIn(); f.changeSession({ authenticated: false }) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(f.authorize).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  view.rerender(f.tree('connectors'))
  act(() => { f.requireSignIn(); f.changeSession({ authenticated: false }) })
  await act(async () => {})
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByRole('button', { name: '测试员工' })
  expect(f.authorize).toHaveBeenCalledOnce()
  act(() => { f.changeSession({ authenticated: false }); f.requireSignIn() })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(f.authorize).toHaveBeenCalledOnce()
})

it.each(['library', 'connectors', 'skills', 'experts'] as const)('keeps signed-out %s content behind one shared dialog', async (catalog) => {
  const f = fixture(), mounted = vi.fn()
  function Page() { mounted(); return <button>Private product content</button> }
  const tree = () => <>{f.tree()}<EmployeeContent t={t}>
    {catalog === 'library' ? <LibraryPanel {...actions} {...f.employeeSignIn} t={t} />
      : catalog === 'connectors' ? <ConnectorsPanel {...actions} {...f.employeeSignIn} t={t} /> : <Page />}
  </EmployeeContent></>
  const view = render(tree())
  const dialog = await screen.findByRole('dialog', { name: zh.authTitle })
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getAllByRole('button', { name: zh.signIn })).toHaveLength(1)
  expect(screen.queryByText('使用企业钉钉账号登录，访问你有权限使用的资源。')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(f.resources).not.toHaveBeenCalled()
  expect(mounted).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'alice', displayName: '员工甲' }) })
  await act(async () => {})
  const node = catalog === 'library' ? await screen.findByRole('searchbox', { name: zh.librarySearch })
    : catalog === 'connectors' ? await screen.findByRole('button', { name: zh.addExtension })
      : screen.getByRole('button', { name: 'Private product content' })
  node.focus()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'alice', displayName: '员工甲' }) })
  view.rerender(tree())
  expect(node.isConnected).toBe(true)
  expect(document.activeElement).toBe(node)
  act(() => { f.requireSignIn() })
  expect(node.isConnected).toBe(false)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.queryByText('使用企业钉钉账号登录，访问你有权限使用的资源。')).toBeNull()
})

it('retains access verification errors through retry and ignores an identity read after expiration', async () => {
  const f = fixture()
  f.getSession.mockRejectedValueOnce(new Error('Identity offline'))
  render(<EmployeeContent t={t}><button>Private product content</button></EmployeeContent>)
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const delayed = Promise.withResolvers<Awaited<ReturnType<typeof f.getSession>>>()
  f.getSession.mockReturnValueOnce(delayed.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(document.activeElement).toBe(retry)
  expect(f.getSession).toHaveBeenCalledTimes(2)
  act(() => { f.requireSignIn() })
  await act(async () => { delayed.resolve({ authenticated: true, employeeId: 'stale' }) })
  expect(screen.queryByRole('button', { name: 'Private product content' })).toBeNull()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'alice' }) })
  expect(screen.getByRole('button', { name: 'Private product content' })).toBeDefined()
})

it.each(['library', 'connectors'] as const)('reuses verified identity and returns retry focus to %s search', async (catalog) => {
  const f = fixture()
  f.getSession.mockRejectedValueOnce(new Error('Identity offline'))
  render(<EmployeeContent t={t}>{catalog === 'library'
    ? <LibraryPanel {...actions} {...f.employeeSignIn} t={t} />
    : <ConnectorsPanel {...actions} {...f.employeeSignIn} t={t} />}</EmployeeContent>)
  const retry = await screen.findByRole('button', { name: zh.retry })
  f.getSession.mockResolvedValue({ authenticated: true, employeeId: 'alice' })
  retry.focus(); fireEvent.click(retry)
  const search = await screen.findByRole('searchbox', { name: catalog === 'library' ? zh.librarySearch : zh.search })
  expect(document.activeElement).toBe(search)
  expect(f.getSession).toHaveBeenCalledTimes(2)
})

it('opens the shared prompt on expiration and ignores an older authenticated identity read', async () => {
  const f = fixture(), identity = Promise.withResolvers<Awaited<ReturnType<typeof f.getSession>>>()
  f.getSession.mockReturnValue(identity.promise)
  const view = render(f.tree())
  onTestFinished(() => { view.unmount(); identity.resolve({ authenticated: true, employeeId: 'previous' }) })
  act(() => { f.requireSignIn() })
  const dialog = await screen.findByRole('dialog', { name: zh.authTitle })
  await act(async () => { identity.resolve({ authenticated: true, employeeId: 'previous', displayName: '旧员工' }) })
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.queryByRole('button', { name: '旧员工' })).toBeNull()
  expect(f.authorize).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  expect(screen.getByRole('button', { name: zh.employeeSignedOut })).toBeTruthy()
})

it('keeps an unavailable identity distinct from a signed-out employee', async () => {
  const f = fixture()
  f.getSession.mockRejectedValue(new Error('Employee status offline'))
  render(f.tree())
  await screen.findByRole('button', { name: zh.employeeStatusUnavailable })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.authorize).not.toHaveBeenCalled()
})

it.each(['connectors', 'library'] as const)('routes signed-out %s through the persistent sidebar login', async (catalog) => {
  const f = fixture()
  await renderAfterInitialPrompt(f.tree(catalog))
  await screen.findByRole('button', { name: zh.employeeSignedOut })
  expect(screen.queryByRole('heading', { level: 1, name: zh[catalog] })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText(zh.authTitle)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.addExtension })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
  expect(f.resources).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByRole('button', { name: '测试员工' })
  await waitFor(() => { expect(f.resources).toHaveBeenCalled() })
  expect(f.authorize).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain('private-employee')
})

it('routes the signed-out composer library action through shared login without querying private files', async () => {
  const f = fixture(), login = Promise.withResolvers<unknown>()
  f.authorize.mockImplementationOnce(() => login.promise)
  let open!: () => void
  const focusInput = vi.fn(), signIn = vi.spyOn(f.employeeSignIn, 'openEmployeeSignIn')
  await renderAfterInitialPrompt(<>{f.tree()}<TaskLibraryInput sessionId={SessionId('library-login')} t={t} renderFactorySlot={actions.renderFactorySlot}
    subscribeOpen={(callback) => { open = callback; return () => {} }} attachLibraryFiles={vi.fn()}
    openEmployeeSignIn={f.employeeSignIn.openEmployeeSignIn} focusInput={focusInput} /></>)
  await screen.findByRole('button', { name: zh.employeeSignedOut })
  act(() => { open() })
  await screen.findByRole('dialog', { name: zh.authTitle })
  expect(screen.queryByRole('dialog', { name: zh.libraryChooseFiles })).toBeNull()
  expect(f.resources).not.toHaveBeenCalled()
  expect(signIn).toHaveBeenCalledWith(focusInput)
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
  await act(async () => { login.resolve({ authenticated: false }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.cancel).toHaveBeenCalledOnce()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'alice', displayName: '员工甲' }) })
  act(() => { open() })
  await screen.findByRole('dialog', { name: zh.libraryChooseFiles })
  await waitFor(() => { expect(f.resources).toHaveBeenCalledWith('library.list') })
  expect(signIn).toHaveBeenCalledOnce()
})

it('retains composer verification failure and retry focus until employee verification succeeds', async () => {
  const f = fixture(), initial = Promise.withResolvers<Awaited<ReturnType<typeof f.getSession>>>()
  f.getSession.mockReturnValueOnce(initial.promise)
  let open!: () => void
  render(<TaskLibraryInput sessionId={SessionId('library-verification')} t={t} renderFactorySlot={actions.renderFactorySlot}
    subscribeOpen={(callback) => { open = callback; return () => {} }} attachLibraryFiles={vi.fn()}
    openEmployeeSignIn={f.employeeSignIn.openEmployeeSignIn} focusInput={vi.fn()} />)
  act(() => { open() })
  const dialog = screen.getByRole('dialog')
  expect(screen.getByRole('status')).toBeDefined()
  expect(f.resources).not.toHaveBeenCalled()
  await act(async () => { initial.reject(new Error('verification offline')) })
  const alert = await screen.findByRole('alert'), retry = screen.getByRole('button', { name: zh.retry })
  const verified = Promise.withResolvers<Awaited<ReturnType<typeof f.getSession>>>()
  f.getSession.mockReturnValueOnce(verified.promise)
  retry.focus(); fireEvent.click(retry); fireEvent.click(retry)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(screen.getByRole('alert')).toBe(alert)
  expect(screen.getByRole('button', { name: zh.retry })).toBe(retry)
  expect(document.activeElement).toBe(retry)
  expect(f.getSession).toHaveBeenCalledTimes(2)
  expect(f.resources).not.toHaveBeenCalled()
  await act(async () => { verified.resolve({ authenticated: true, employeeId: 'alice' }) })
  await waitFor(() => { expect(f.resources).toHaveBeenCalledOnce() })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.cancel }))
})

it('clears private file rows before loading the new employee files and retains its failure for retry', async () => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'alice', displayName: '员工甲' })
  const file = { entry: { id: '22222222-2222-4222-8222-222222222222', libraryId: '11111111-1111-4111-8111-111111111111',
    parentId: null, name: '甲的私人资料.md', kind: 'FILE', sha256: 'a'.repeat(64), mediaType: 'text/markdown',
    sizeBytes: 64, version: 1, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' },
  libraryName: '个人资料', canManage: true, lastAccessedAt: null, sourceKind: 'UPLOAD', sourceSessionId: null }
  f.resources.mockResolvedValue({ data: [file], pageIndex: 1, pageSize: 20, totalCount: 1, totalPages: 1 })
  await renderAfterInitialPrompt(f.tree('library'))
  await screen.findByRole('button', { name: /^甲的私人资料/ })
  f.resources.mockImplementation(async (method) => {
    if (method === 'library.files.list') throw new Error('New employee directory unavailable')
    return { data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 }
  })
  act(() => { f.changeSession({ authenticated: true, employeeId: 'bob', displayName: '员工乙' }) })
  await screen.findByRole('alert')
  await waitFor(() => { expect(screen.queryByRole('button', { name: /^甲的私人资料/ })).toBeNull() })
  f.resources.mockResolvedValue({ data: [], pageIndex: 1, pageSize: 20, totalCount: 0, totalPages: 0 })
  fireEvent.click(screen.getByRole('button', { name: zh.retry }))
  await screen.findByText(zh.libraryEmpty)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('button', { name: /^甲的私人资料/ })).toBeNull()
})

it('shows the same signed-out label in wide and collapsed sidebars and reacts to employee events', async () => {
  const f = fixture()
  const view = await renderAfterInitialPrompt(f.tree())
  await screen.findByRole('button', { name: zh.employeeSignedOut })
  view.rerender(f.tree(undefined, t, false))
  expect(screen.getByRole('button', { name: zh.employeeSignedOut }).title).toBe(zh.employeeSignedOut)
  act(() => { f.changeSession({ authenticated: true, employeeId: 'private-employee', displayName: '测试员工' }) })
  expect(screen.getByRole('button', { name: '测试员工' })).toBeDefined()
  act(() => { f.changeSession({ authenticated: false }) })
  expect(screen.getByRole('button', { name: zh.employeeSignedOut })).toBeDefined()
  expect(document.body.textContent).not.toContain('测试员工')
})

it.each([true, false])('uses one employee button to toggle the menu with sidebar wide=%s', async (wide) => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
  await renderAfterInitialPrompt(f.tree(undefined, t, wide))
  const employee = await screen.findByRole('button', { name: '测试员工' })
  expect(screen.getAllByRole('button')).toEqual([employee])
  fireEvent.click(employee)
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  fireEvent.pointerDown(employee)
  fireEvent.click(employee)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(f.authorize).not.toHaveBeenCalled()
})

it.each([true, false])('keeps settings and explicit sign-in in one signed-out menu with sidebar wide=%s', async (wide) => {
  const f = fixture()
  await renderAfterInitialPrompt(f.tree(undefined, t, wide))
  const employee = await screen.findByRole('button', { name: zh.employeeSignedOut })
  expect(screen.getAllByRole('button')).toEqual([employee])
  fireEvent.click(employee)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([zh.signIn, zh.settings, zh.feedbackTitle])
  expect(f.authorize).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByRole('button', { name: '测试员工' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(f.authorize).toHaveBeenCalledOnce()
})

it('returns keyboard focus to the employee name after dismissing its menu', async () => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
  await renderAfterInitialPrompt(f.tree())
  const employee = await screen.findByRole('button', { name: '测试员工' })
  employee.focus()
  fireEvent.click(employee)
  await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: zh.settings })) })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement).toBe(employee)
})

it.each(['feedback', 'signin'] as const)('returns keyboard focus to the employee entry after dismissing %s', async (entry) => {
  const f = fixture()
  const authorization = Promise.withResolvers<unknown>()
  if (entry === 'feedback') f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
  else f.authorize.mockImplementation(() => authorization.promise)
  await renderAfterInitialPrompt(f.tree())
  const employee = await screen.findByRole('button', { name: entry === 'feedback' ? '测试员工' : zh.employeeSignedOut })
  employee.focus()
  fireEvent.click(employee)
  await waitFor(() => { expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: entry === 'feedback' ? zh.settings : zh.signIn })) })
  fireEvent.click(screen.getByRole('menuitem', { name: entry === 'feedback' ? zh.feedbackTitle : zh.signIn }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => { expect(dialog.contains(document.activeElement)).toBe(true) })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(document.activeElement).toBe(employee)
  await act(async () => { authorization.resolve({ authenticated: false }) })
})

it.each([true, false])('opens feedback after shared sign-in, with a successful employee event=%s', async (emitsEvent) => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  await screen.findByText(zh.authBrowserHint)
  expect(screen.queryByRole('textbox', { name: zh.feedbackMessage })).toBeNull()
  expect(f.resources).not.toHaveBeenCalled()
  const session = { authenticated: true, employeeId: 'employee', displayName: '测试员工' }
  await act(async () => {
    if (emitsEvent) f.changeSession(session)
    else f.getSession.mockResolvedValue(session)
    pending.resolve(session)
  })
  const dialog = await screen.findByRole('dialog', { name: zh.feedbackTitle })
  expect(within(dialog).getByRole('textbox', { name: zh.feedbackMessage })).toBeTruthy()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(f.authorize).toHaveBeenCalledOnce()
})

it.each(['cancel', 'success'] as const)('retains workspace nodes, draft and selection after full-window login %s', async (outcome) => {
  const f = fixture(), pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  onTestFinished(() => { pending.resolve({ authenticated: false }) })
  const view = await renderAfterInitialPrompt(<>{f.tree()}<textarea aria-label="Workspace draft" defaultValue="保留会话草稿和选区" /></>)
  const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Workspace draft' })
  input.focus(); input.setSelectionRange(2, 6)
  act(() => { f.employeeSignIn.openEmployeeSignIn() })
  const dialog = screen.getByRole('dialog', { name: zh.authTitle })
  expect(dialog.classList.contains('product-employee-authorization')).toBe(true)
  expect(screen.getByRole('textbox', { name: 'Workspace draft' })).toBe(input)
  if (outcome === 'cancel') fireEvent.click(within(dialog).getByRole('button', { name: zh.cancel }))
  else await act(async () => {
    f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
    pending.resolve({ authenticated: true })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('textbox', { name: 'Workspace draft' })).toBe(input)
  expect(input.value).toBe('保留会话草稿和选区')
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
  expect(document.activeElement).toBe(input)
  view.unmount()
})

it('discards the pending feedback entry when authorization is cancelled', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: zh.cancel }))
  expect(f.cancel).toHaveBeenCalledWith(f.requests[0]!.id)
  await act(async () => {
    f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
    pending.resolve({ authenticated: true })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('textbox', { name: zh.feedbackMessage })).toBeNull()
})

it('closes feedback on sign-out and does not expose the previous employee draft on reopening', async () => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
  await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: '测试员工' }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.feedbackMessage }), { target: { value: '员工的私密草稿' } })
  act(() => { f.changeSession({ authenticated: false }) })
  const login = screen.getByRole('dialog', { name: zh.authTitle })
  expect(screen.queryByRole('textbox', { name: zh.feedbackMessage })).toBeNull()
  fireEvent.click(within(login).getByRole('button', { name: zh.cancel }))
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  expect(await screen.findByRole('textbox', { name: zh.feedbackMessage })).toHaveProperty('value', '')
})

it.each(['connectors'] as const)('waits for identity verification before showing %s enterprise actions', async (catalog) => {
  const f = fixture()
  const initial = Promise.withResolvers<{ authenticated: boolean }>()
  f.getSession.mockImplementation(() => initial.promise)
  render(f.tree(catalog))
  expect(screen.getByRole('button', { name: zh.loading })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.addExtension })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.libraryNewFolder })).toBeNull()
  await act(async () => { initial.resolve({ authenticated: false }) })
  await screen.findByRole('button', { name: zh.employeeSignedOut })
  expect(f.resources).not.toHaveBeenCalled()
})

it('does not let a late initial identity read overwrite a newer employee event', async () => {
  const f = fixture()
  const initial = Promise.withResolvers<{ authenticated: boolean }>()
  f.getSession.mockImplementationOnce(() => initial.promise)
  render(f.tree())
  expect(screen.getByRole('button', { name: zh.loading })).toHaveProperty('disabled', true)
  act(() => { f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' }) })
  await act(async () => { initial.resolve({ authenticated: false }) })
  expect(screen.getByRole('button', { name: '测试员工' })).toBeDefined()
  expect(screen.queryByRole('button', { name: zh.employeeSignedOut })).toBeNull()
})

it('keeps authorization alive across resource navigation and the successful employee event', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  const view = await renderAfterInitialPrompt(f.tree('connectors'))
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByText(zh.authBrowserHint)
  expect(f.requests[0]?.timeout).toBeGreaterThan(DINGTALK_AUTHORIZATION_TIMEOUT_MS)
  view.rerender(f.tree('library'))
  expect(screen.queryByRole('heading', { level: 1, name: zh.library })).toBeNull()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(f.cancel).not.toHaveBeenCalledWith(f.requests[0]!.id)
  act(() => { f.changeSession({ authenticated: true, employeeId: 'employee', displayName: '测试员工' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.cancel).not.toHaveBeenCalledWith(f.requests[0]!.id)
  await act(async () => { pending.resolve({ authenticated: true }) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('cancels authorization and ignores a late failure while a new login is waiting', async () => {
  const f = fixture()
  const first = Promise.withResolvers<unknown>()
  const second = Promise.withResolvers<unknown>()
  f.authorize.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: zh.cancel }))
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(f.requests[0]!.id)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await act(async () => { first.reject(new Error('Private cancelled diagnostic')) })
  const waiting = within(screen.getByRole('dialog')).getByRole('button', { name: zh.signingIn })
  expect(waiting).toHaveProperty('disabled', false)
  expect(waiting.getAttribute('aria-disabled')).toBe('true')
  expect(waiting.getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => {
    f.changeSession({ authenticated: true, employeeId: 'employee' })
    second.resolve({ authenticated: true })
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps a failed login retryable and translates its message without starting another request', async () => {
  const f = fixture()
  f.authorize.mockRejectedValueOnce(new Error('Private browser failure'))
  const view = await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.signInFailed)
  view.rerender(f.tree(undefined, makeTranslate(en, commonZh)))
  expect(screen.getByRole('alert').textContent).toBe(en.signInFailed)
  expect(f.authorize).toHaveBeenCalledOnce()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en.signIn }))
  await screen.findByRole('button', { name: '测试员工' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.body.textContent).not.toContain('Private browser failure')
})

it.each((['zh', 'en'] as const).flatMap(language => (['accepted', 'failed'] as const).map(outcome => ({ language, outcome }))))(
  'retains shared login feedback and keyboard focus during a $language retry until $outcome', async ({ language, outcome }) => {
    const f = fixture()
    const retry = Promise.withResolvers<unknown>()
    f.authorize.mockRejectedValueOnce(new Error('Private initial failure')).mockImplementationOnce(() => retry.promise)
    const labels = language === 'zh' ? zh : en
    const view = await renderAfterInitialPrompt(f.tree(undefined, makeTranslate(labels, commonZh)))
    onTestFinished(() => { view.unmount(); retry.resolve({ authenticated: false }) })
    fireEvent.click(await screen.findByRole('button', { name: labels.employeeSignedOut }))
    fireEvent.click(screen.getByRole('menuitem', { name: labels.signIn }))
    const notice = await screen.findByRole('alert')
    const dialog = screen.getByRole('dialog')
    const action = within(dialog).getByRole<HTMLButtonElement>('button', { name: labels.signIn })
    const cancel = within(dialog).getByRole('button', { name: labels.cancel })
    action.focus()
    fireEvent.click(action)
    fireEvent.click(action)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toBe(notice)
    expect(within(dialog).getByRole('button', { name: labels.signingIn })).toBe(action)
    expect(action.disabled).toBe(false)
    expect(action.getAttribute('aria-disabled')).toBe('true')
    expect(action.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(action)
    expect(within(dialog).getByRole('button', { name: labels.cancel })).toBe(cancel)
    if (outcome === 'accepted') {
      await act(async () => {
        f.getSession.mockResolvedValue({ authenticated: true, employeeId: 'employee', displayName: '测试员工' })
        retry.resolve({ authenticated: true })
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    } else {
      await act(async () => { retry.reject(new Error('Private retry failure')) })
      expect(screen.getByRole('dialog')).toBe(dialog)
      expect(screen.getByRole('alert')).toBe(notice)
      expect(within(dialog).getByRole('button', { name: labels.signIn })).toBe(action)
      expect(document.activeElement).toBe(action)
      expect(action.getAttribute('aria-busy')).toBe('false')
      expect({ feedback: notice.textContent, focused: document.activeElement === action,
        busy: action.getAttribute('aria-busy') }).toMatchSnapshot('Shared sign-in retry')
    }
  },
)

it('cancels waiting authorization and releases its event subscription with the launcher', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  const view = await renderAfterInitialPrompt(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByText(zh.authBrowserHint)
  const reads = f.getSession.mock.calls.length
  view.unmount()
  expect(f.cancel).toHaveBeenCalledWith(f.requests[0]!.id)
  f.employeeSignIn.openEmployeeSignIn()
  expect(f.authorize).toHaveBeenCalledOnce()
  await act(async () => { pending.resolve({ authenticated: true }) })
  expect(f.getSession).toHaveBeenCalledTimes(reads)
})

it.each(['connectors'] as const)('closes the %s editor after definitive authorization failure despite a stale local snapshot', async (catalog) => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'employee' })
  await renderAfterInitialPrompt(f.tree(catalog))
  fireEvent.click(await screen.findByRole('button', { name: zh.addExtension }))
  await screen.findByRole('dialog')
  f.resources.mockRejectedValue(new ProductError('EMPLOYEE_UNAUTHORIZED', 'Private server diagnostic'))
  act(() => { f.refreshCatalog(); f.requireSignIn() })
  const login = await screen.findByRole('dialog', { name: zh.authTitle })
  expect(screen.getAllByRole('dialog')).toEqual([login])
  expect(within(login).getByRole('button', { name: zh.signIn })).toBeDefined()
  expect(screen.queryByText(/EMPLOYEE_UNAUTHORIZED|Private server diagnostic/u)).toBeNull()
})

it('routes an open picker to shared login when its initial identity read confirms sign-out', async () => {
  const f = fixture(), identity = Promise.withResolvers<Awaited<ReturnType<typeof f.getSession>>>()
  f.getSession.mockReturnValueOnce(identity.promise)
  let open!: () => void
  const signIn = vi.fn(), focusInput = vi.fn()
  render(<TaskLibraryInput sessionId={SessionId('pending-picker-login')} t={t} renderFactorySlot={actions.renderFactorySlot}
    subscribeOpen={(callback) => { open = callback; return () => {} }} attachLibraryFiles={vi.fn()}
    openEmployeeSignIn={signIn} focusInput={focusInput} />)
  act(() => { open() })
  expect(screen.getByRole('dialog', { name: zh.libraryChooseFiles })).toBeDefined()
  await act(async () => { identity.resolve({ authenticated: false }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(signIn).toHaveBeenCalledExactlyOnceWith(focusInput)
  expect(f.resources).not.toHaveBeenCalled()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'employee' }) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps the employee trigger and unrelated actions stable when sign-out fails, then opens the shared login after success', async () => {
  const f = fixture()
  act(() => { f.changeSession({ authenticated: true, employeeId: 'private-employee', displayName: '测试员工' }) })
  render(f.tree())
  const trigger = await screen.findByRole('button', { name: '测试员工' })
  f.resources.mockImplementationOnce(async (method) => {
    expect(method).toBe('auth.signOut')
    throw new ProductError('PRODUCT_NETWORK_UNAVAILABLE', 'Offline', true)
  })
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signOut }))
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: '测试员工' })).toBe(trigger)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger)
  expect(screen.getByRole('menuitem', { name: zh.settings }).getAttribute('aria-disabled')).not.toBe('true')
  f.resources.mockImplementationOnce(async (method) => {
    expect(method).toBe('auth.signOut')
    f.changeSession({ authenticated: false })
    return { authenticated: false }
  })
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signOut }))
  await screen.findByRole('dialog', { name: zh.authTitle })
  expect(f.authorize).not.toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
})
