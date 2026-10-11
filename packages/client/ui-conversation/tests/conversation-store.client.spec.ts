// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { DraftSnapshot } from '../src/client/contract/draft-editor.ts'
import { createConversationStore, readConversationDraft, readConversationViewPreference } from '../src/client/stores.ts'

const KEY = 'dsh.conversation'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createConversationStore', () => {
  it('owns draft, selected View, and one-shot View requests', () => {
    const store = createConversationStore().create()
    expect(store.getSnapshot()).toEqual({ draft: '', view: null, viewRequest: null })

    store.actions.setDraft('hello')
    store.actions.setView('chat')
    expect(store.getSnapshot()).toEqual({
      draft: 'hello',
      view: 'chat',
      viewRequest: null,
    })

    store.actions.openView('trajectory', 'call-1')
    expect(store.getSnapshot()).toMatchObject({
      view: 'trajectory',
      viewRequest: { view: 'trajectory', focus: 'call-1' },
    })
    store.actions.completeViewRequest()
    expect(store.getSnapshot().viewRequest).toBeNull()
  })

  it('persists per Session scope and clears the persisted value', () => {
    const first = createConversationStore().create('sess-1')
    first.actions.setDraft('draft for one')
    first.actions.setView('chat')
    expect(localStorage.getItem(`${KEY}.sess-1`)).not.toBeNull()
    expect(localStorage.getItem(`${KEY}.sess-2`)).toBeNull()

    const restored = createConversationStore().create('sess-1')
    expect(restored.getSnapshot()).toMatchObject({
      draft: 'draft for one',
      view: 'chat',
    })

    first.clearPersisted()
    expect(localStorage.getItem(`${KEY}.sess-1`)).toBeNull()
  })

  it('creates independent live instances', () => {
    const handle = createConversationStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.setDraft('only first')
    expect(second.getSnapshot().draft).toBe('')
  })

  it('persists a draft assigned before the composer mounts and restores it after remount', () => {
    const shell = new SessionInputShell({
      actx: {} as Context,
      defaultSink: vi.fn(),
      commandAttachments: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    })
    shell.setDraft('Transferred task draft')
    const handle = createConversationStore()
    const store = handle.create('replacement-session')
    const unbind = shell.bindDraftPersistence(store.actions.setDraft)
    shell.persistCurrentDraft()
    expect(handle.create('replacement-session').getSnapshot().draft).toEqual({ text: 'Transferred task draft', references: [] })
    unbind()
    shell.setDraft('Detached editor draft')
    expect(handle.create('replacement-session').getSnapshot().draft).toEqual({ text: 'Transferred task draft', references: [] })
    shell.dispose()
  })

  it('reads only a usable persisted View preference', () => {
    const sessionId = 'sess-1' as SessionId
    const store = createConversationStore().create(sessionId)
    store.actions.setView('trajectory')
    expect(readConversationViewPreference(sessionId)).toBe('trajectory')

    localStorage.setItem(`${KEY}.${sessionId}`, '{invalid')
    expect(readConversationViewPreference(sessionId)).toBeNull()
  })

  it('restores structured references from the Session store and persists their removal', () => {
    const sessionId = 'structured' as SessionId
    const draft: DraftSnapshot = {
      text: '🙂 @file @file',
      references: [3, 9].map(offset => ({
        source: 'reference', ref: '@file', label: 'file', appearance: 'file',
        clipboardText: '@file', offset, length: 5, invalid: true,
      })),
    }
    const store = createConversationStore().create(sessionId)
    store.actions.setDraft(draft)
    store.actions.setView('trajectory')

    expect(JSON.parse(localStorage.getItem(`${KEY}.${sessionId}`)!)).toEqual({
      draft, view: 'trajectory', viewRequest: null,
    })
    expect(readConversationDraft(sessionId)).toEqual(draft)
    expect(createConversationStore().create(sessionId).getSnapshot().draft).toEqual(draft)
    expect(readConversationDraft('another-session' as SessionId)).toEqual({ text: '', references: [] })

    store.actions.setDraft({ text: '', references: [] })
    expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
    expect(createConversationStore().create(sessionId).getSnapshot().draft).toEqual({ text: '', references: [] })
    expect(readConversationViewPreference(sessionId)).toBe('trajectory')
  })

  it('reads a legacy draft without rewriting the saved record', () => {
    const sessionId = 'legacy' as SessionId
    const raw = JSON.stringify({ draft: '🙂 draft\nsecond line', view: 'chat' })
    localStorage.setItem(`${KEY}.${sessionId}`, raw)
    expect(readConversationDraft(sessionId)).toEqual({ text: '🙂 draft\nsecond line', references: [] })
    expect(localStorage.getItem(`${KEY}.${sessionId}`)).toBe(raw)
  })

  it.each(['null', '42', '"text"', '[]', '{}', '{invalid'])('ignores unusable saved records: %s', (raw) => {
    const sessionId = 'invalid-record' as SessionId
    localStorage.setItem(`${KEY}.${sessionId}`, raw)
    expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
    expect(readConversationViewPreference(sessionId)).toBeNull()
    expect(localStorage.getItem(`${KEY}.${sessionId}`)).toBe(raw)
  })

  it.each([
    null,
    42,
    { text: 'missing references' },
    { text: '@entry', references: [{
      source: 'reference', ref: '@entry', label: 'entry', clipboardText: '@entry', offset: 1, length: 6,
    }] },
  ])('ignores an invalid saved draft while retaining a usable View: %j', (draft) => {
    const sessionId = 'invalid-draft' as SessionId
    localStorage.setItem(`${KEY}.${sessionId}`, JSON.stringify({ draft, view: 'chat' }))
    expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
    expect(readConversationViewPreference(sessionId)).toBe('chat')
  })

  it.each([{}, { view: null }, { view: 7 }])('reads a draft independently of an unusable View: %j', (view) => {
    const sessionId = 'invalid-view' as SessionId
    localStorage.setItem(`${KEY}.${sessionId}`, JSON.stringify({ draft: 'saved', ...view }))
    expect(readConversationDraft(sessionId)).toEqual({ text: 'saved', references: [] })
    expect(readConversationViewPreference(sessionId)).toBeNull()
  })

  it('returns empty preferences for a missing record', () => {
    const sessionId = 'missing' as SessionId
    expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
    expect(readConversationViewPreference(sessionId)).toBeNull()
  })

  it('returns empty preferences when browser storage is absent', () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      const sessionId = 'unavailable' as SessionId
      expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
      expect(readConversationViewPreference(sessionId)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('returns empty preferences when browser storage denies access', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError')
    })
    try {
      const sessionId = 'denied' as SessionId
      expect(readConversationDraft(sessionId)).toEqual({ text: '', references: [] })
      expect(readConversationViewPreference(sessionId)).toBeNull()
      expect(read.mock.calls).toEqual([[`${KEY}.${sessionId}`], [`${KEY}.${sessionId}`]])
    } finally { read.mockRestore() }
  })
})
