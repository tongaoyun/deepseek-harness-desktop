// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ProductError, productFailure } from '@deepseek-harness/product/errors'
import { DINGTALK_AUTHORIZATION_TIMEOUT_MS } from '@deepseek-harness/product/protocol'
import { ConnectorsPanel, KnowledgePanel } from '../src/client/DeepSeekHarnessCatalogSection.tsx'
import { DeepSeekHarnessSettingsMenu } from '../src/client/DeepSeekHarnessSettingsMenu.tsx'
import { createEmployeeSignInActions } from '../src/client/employee-sign-in.ts'
import { en, zh } from '../src/locales.ts'
import { renderKnowledgePreview } from './knowledge-preview-fixture.client.tsx'

const contexts: Context[] = []
afterEach(async () => {
  cleanup()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})
const t = makeTranslate(zh, commonZh)
function unusedSlot(): never { throw new Error('Employee sign-in does not read this slot') }
const actions = {
  useContextMenu: contextMenuHook(),
  usePanelInfo: unusedSlot, useRemoteAccess: unusedSlot, useSessionAccess: unusedSlot, useWorkspaceAccess: unusedSlot,
  useSessions: unusedSlot, useSessionStatus: unusedSlot, useSessionRetainInfo: unusedSlot,
  useWorkspaces: unusedSlot, useResource: unusedSlot, useAccess: unusedSlot, renderFactorySlot: renderKnowledgePreview,
}

function fixture() {
  type Session = { authenticated: boolean; employeeId?: string; displayName?: string }
  let session: Session = { authenticated: false }
  const listeners = new Set<(event: { type: string; payload?: unknown }) => void>()
  const requests: { id: string; timeout?: number }[] = []
  const cancel = vi.fn()
  const getSession = vi.fn(async () => session)
  const resources = vi.fn(async (_method: string): Promise<unknown> => [])
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
  const tree = (catalog?: 'connectors' | 'knowledge', translate = t, wide = true) => <>
    <DeepSeekHarnessSettingsMenu {...actions} {...employeeSignIn} t={translate} wide={wide}
      settingsOpen={false} openSettings={vi.fn()} openOnboarding={vi.fn()} />
    {catalog === 'knowledge' ? <KnowledgePanel {...actions} {...employeeSignIn} t={translate} />
      : catalog === 'connectors' ? <ConnectorsPanel {...actions} {...employeeSignIn} t={translate} /> : null}
  </>
  return { tree, requests, cancel, getSession, resources, authorize, changeSession, employeeSignIn,
    refreshCatalog: () => { for (const listener of listeners) listener({ type: 'catalog.changed' }) } }
}

it.each(['connectors', 'knowledge'] as const)('routes signed-out %s through the persistent sidebar login', async (catalog) => {
  const f = fixture()
  render(f.tree(catalog))
  await screen.findByRole('button', { name: zh.employeeSignedOut })
  expect(screen.getByRole('heading', { level: 1, name: zh[catalog] })).toBeDefined()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByText(zh.authTitle)).toBeNull()
  expect(screen.queryByRole('button', { name: zh.addExtension })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeCreatePersonalBase })).toBeNull()
  expect(f.resources).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh.signIn }))
  await screen.findByRole('button', { name: '测试员工' })
  await waitFor(() => { expect(f.resources).toHaveBeenCalled() })
  expect(f.authorize).toHaveBeenCalledOnce()
  expect(document.body.textContent).not.toContain('private-employee')
})

it('shows the same signed-out label in wide and collapsed sidebars and reacts to employee events', async () => {
  const f = fixture()
  const view = render(f.tree())
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
  render(f.tree(undefined, t, wide))
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
  render(f.tree(undefined, t, wide))
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
  render(f.tree())
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
  render(f.tree())
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
  render(f.tree())
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

it('discards the pending feedback entry when authorization is cancelled', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  render(f.tree())
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
  render(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: '测试员工' }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  fireEvent.change(screen.getByRole('textbox', { name: zh.feedbackMessage }), { target: { value: '员工的私密草稿' } })
  act(() => { f.changeSession({ authenticated: false }) })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.feedbackTitle }))
  expect(await screen.findByRole('textbox', { name: zh.feedbackMessage })).toHaveProperty('value', '')
})

it.each(['connectors', 'knowledge'] as const)('waits for identity verification before showing %s enterprise actions', async (catalog) => {
  const f = fixture()
  const initial = Promise.withResolvers<{ authenticated: boolean }>()
  f.getSession.mockImplementation(() => initial.promise)
  render(f.tree(catalog))
  expect(screen.getByRole('button', { name: zh.loading })).toHaveProperty('disabled', true)
  expect(screen.queryByRole('button', { name: zh.signIn })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.addExtension })).toBeNull()
  expect(screen.queryByRole('button', { name: zh.knowledgeCreatePersonalBase })).toBeNull()
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
  const view = render(f.tree('connectors'))
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await screen.findByText(zh.authBrowserHint)
  expect(f.requests[0]?.timeout).toBeGreaterThan(DINGTALK_AUTHORIZATION_TIMEOUT_MS)
  view.rerender(f.tree('knowledge'))
  await screen.findByRole('heading', { level: 1, name: zh.knowledge })
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
  render(f.tree())
  fireEvent.click(await screen.findByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: zh.cancel }))
  expect(f.cancel).toHaveBeenCalledExactlyOnceWith(f.requests[0]!.id)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.employeeSignedOut }))
  fireEvent.click(screen.getByRole('menuitem', { name: zh.signIn }))
  await act(async () => { first.reject(new Error('Private cancelled diagnostic')) })
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: zh.signingIn })).toHaveProperty('disabled', true)
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
  const view = render(f.tree())
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

it('cancels waiting authorization and releases its event subscription with the launcher', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<unknown>()
  f.authorize.mockImplementation(() => pending.promise)
  const view = render(f.tree())
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

it.each(['connectors', 'knowledge'] as const)('closes the %s editor after definitive authorization failure despite a stale local snapshot', async (catalog) => {
  const f = fixture()
  f.changeSession({ authenticated: true, employeeId: 'employee' })
  render(f.tree(catalog))
  fireEvent.click(await screen.findByRole('button', { name: catalog === 'knowledge' ? zh.knowledgeCreatePersonalBase : zh.addExtension }))
  await screen.findByRole('dialog')
  f.resources.mockRejectedValue(new ProductError('EMPLOYEE_UNAUTHORIZED', 'Private server diagnostic'))
  act(() => { f.refreshCatalog() })
  await screen.findByRole('button', { name: zh.signIn })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByText(/EMPLOYEE_UNAUTHORIZED|Private server diagnostic/u)).toBeNull()
})
