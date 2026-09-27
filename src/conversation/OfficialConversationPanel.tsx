import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useEffect, useRef, useState } from 'react'
import { importPastedFile, importPastedImage, inspectHarnessSession, searchHarnessSessionsPage, type HarnessNotification } from '../harness'
import type { LocalTaskAttachment } from '../types'
import { isTauriRuntime } from '../auth'
import { loadOfficialClientRoster, releaseOfficialClientRuntime } from './officialModuleLoader'

export interface OfficialConversationPanelProps {
  employeeId?: string
  sessionId?: string
  model?: string
  sessionReferences?: Array<{ sessionId: string; label: string; updatedAt: string }>
  onPrompt?: (text: string, sessionId?: string, mode?: 'queue' | 'steer', attachments?: LocalTaskAttachment[], requestId?: string) => void
  onRename?: (sessionId: string, title: string) => void
  onSelectModel?: (model: string) => void
  onQueueUpdate?: (sessionId: string, itemId: string, action: { kind: 'remove' } | { kind: 'edit'; text: string } | { kind: 'steer' }) => void
  onCancel?: () => void
}

/**
 * The product conversation surface is the upstream Harness browser app. The
 * desktop only supplies a Connection RPC carrier; it does not render turns,
 * tool cards, approvals or questions itself.
 */
export function OfficialConversationPanel(props: OfficialConversationPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const [error, setError] = useState('')
  const bridgeRef = useRef<OfficialSessionBridge | undefined>(undefined)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let entry: { run: (onFailure?: (reason: unknown) => void) => Promise<void>; dispose: () => Promise<void> } | undefined
    const bridge = new OfficialSessionBridge(propsRef)
    bridgeRef.current = bridge
    const previousTransport = (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
    const previousBoot = (globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__
    const previousReady = (globalThis as { __DSH_BOOT_READY__?: { promise: PromiseLike<void> } }).__DSH_BOOT_READY__
    const previousModuleLoader = (globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__
    const previousWindowModuleLoader = (globalThis as { window?: { __ModuleLoader__?: unknown } }).window?.__ModuleLoader__
    const previousProcess = (globalThis as { process?: unknown }).process
    if (previousProcess === undefined) {
      ;(globalThis as { process?: unknown }).process = {
        env: { NODE_ENV: import.meta.env.MODE },
        versions: { node: '20.0.0' },
        execArgv: [],
      }
    }
    const boot = bootGraph()
    ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = boot
    ;(globalThis as { __DSH_BOOT_READY__?: { promise: PromiseLike<void> } }).__DSH_BOOT_READY__ = { promise: Promise.resolve() }
    ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = { rpc: bridge.rpc }
    const previousFileUpload = (globalThis as { __DSH_FILE_UPLOAD__?: unknown }).__DSH_FILE_UPLOAD__
    ;(globalThis as { __DSH_FILE_UPLOAD__?: unknown }).__DSH_FILE_UPLOAD__ = {
      fetch: (path: string, init: RequestInit) => bridge.fileUpload(path, init),
    }
    void (async () => {
      try {
        await loadOfficialClientRoster()
        const { AppWebEntry } = await import('@deepseek-ai/dsh-client-web')
        entry = new AppWebEntry(container)
        if (!disposed) await entry.run((reason) => setError(officialErrorMessage(reason)))
        if (disposed) await entry.dispose()
      } catch (reason) {
        if (!disposed) setError(officialErrorMessage(reason))
      }
    })()
    return () => {
      disposed = true
      bridge.dispose()
      void entry?.dispose()
      ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = previousTransport
      ;(globalThis as { __DSH_FILE_UPLOAD__?: unknown }).__DSH_FILE_UPLOAD__ = previousFileUpload
      ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = previousBoot
      ;(globalThis as { __DSH_BOOT_READY__?: { promise: PromiseLike<void> } }).__DSH_BOOT_READY__ = previousReady
      ;(globalThis as { __ModuleLoader__?: unknown }).__ModuleLoader__ = previousModuleLoader
      const windowGlobal = (globalThis as { window?: { __ModuleLoader__?: unknown } }).window
      if (windowGlobal) windowGlobal.__ModuleLoader__ = previousWindowModuleLoader
      ;(globalThis as { process?: unknown }).process = previousProcess
      releaseOfficialClientRuntime()
      if (bridgeRef.current === bridge) bridgeRef.current = undefined
    }
  }, [props.employeeId, props.model, props.sessionId])

  return <div className="official-conversation-panel" ref={containerRef} data-official-conversation="true">
    {error && <div className="official-conversation-error" role="alert">官方会话界面启动失败：{error}</div>}
  </div>
}

function officialErrorMessage(reason: unknown): string {
  if (!(reason instanceof Error)) return String(reason)
  return reason.message
}

class OfficialSessionBridge {
  private readonly listeners = new Set<UnlistenFn>()
  private disposed = false
  readonly rpc = {
    call: async (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => {
      if (channel !== '/api') return failure('gateway/channel-invalid', '不支持的 Harness 通道')
      if (signal?.aborted) throw signal.reason
      const args = record(payload)?.args
      const result = await this.callEndpoint(endpoint, args)
      if (signal?.aborted) throw signal.reason
      return result
    },
    open: (channel: string, endpoint: string, payload: unknown, signal: AbortSignal) => {
      if (channel !== '/api') throw new Error('不支持的 Harness 通道')
      const args = record(payload)?.args
      return this.openEndpoint(endpoint, args, signal)
    },
  }

  constructor(private readonly propsRef: { current: OfficialConversationPanelProps }) {}

  dispose(): void {
    this.disposed = true
    for (const unlisten of this.listeners) unlisten()
    this.listeners.clear()
  }

  private async callEndpoint(endpoint: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }> {
    const sessionId = this.sessionId(args)
    if (endpoint === 'fileReferences/list') {
      // The desktop's authorized-directory picker is product-owned. Returning
      // an empty official reference list keeps the upstream composer honest:
      // it never suggests files that have not been explicitly authorized.
      return { ok: true, value: [] }
    }
    if (endpoint === 'session/list') {
      const references = this.propsRef.current.sessionReferences ?? []
      const ids = [...new Set([sessionId, ...references.map((item) => item.sessionId)].filter((value): value is string => Boolean(value)))]
      const items = await Promise.all(ids.map(async (id) => {
        const inspection = this.propsRef.current.employeeId ? await inspectHarnessSession(this.propsRef.current.employeeId, id) : undefined
        const reference = references.find((item) => item.sessionId === id)
        return summary(id, inspection, reference)
      }))
      return { ok: true, value: { items: items.sort((a, b) => b.updatedAt - a.updatedAt) } }
    }
    if (endpoint === 'session/search') {
      const query = String(record(args)?.query ?? '').trim()
      const references = this.propsRef.current.sessionReferences ?? []
      const ids = [...new Set([sessionId, ...references.map((item) => item.sessionId)].filter((value): value is string => Boolean(value)))]
      if (!query || !this.propsRef.current.employeeId) return { ok: true, value: { items: [], hasMore: false } }
      const result = await searchHarnessSessionsPage(this.propsRef.current.employeeId, ids, query, 20)
      return { ok: true, value: { items: result.items.map((item) => ({ sessionId: item.sessionId, snippet: item.excerpt })), hasMore: Boolean(result.nextCursor) } }
    }
    if (endpoint === 'session/projections') {
      const inspection = sessionId && this.propsRef.current.employeeId ? await inspectHarnessSession(this.propsRef.current.employeeId, sessionId) : undefined
      return { ok: true, value: projectionBaseline(inspection) }
    }
    if (endpoint === 'session/page') {
      return { ok: true, value: { records: await this.records(addressSessionId(args) ?? sessionId, args), hasMore: false } }
    }
    if (endpoint === 'session/modelCatalog') {
      const model = this.propsRef.current.model?.trim() || 'deepseek-v4-flash'
      return {
        ok: true,
        value: {
          default: { provider: 'deepseek', model },
          routableProviders: ['deepseek'],
          groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: model, name: model }] }],
          failures: [],
        },
      }
    }
    if (endpoint === 'session/prompt') {
      const text = promptText(args)
      const mode = promptMode(args)
      const attachments = await this.promptAttachments(args)
      const requestId = typeof record(args)?.requestId === 'string' ? String(record(args)?.requestId) : undefined
      if (text || attachments.length) this.propsRef.current.onPrompt?.(text ?? '', sessionId, mode, attachments, requestId)
      return { ok: true, value: { accepted: true } }
    }
    if (endpoint === 'session/cancel') {
      this.propsRef.current.onCancel?.()
      return { ok: true, value: { accepted: true } }
    }
    if (endpoint === 'session/create') {
      // `session/create` is the official new-session boundary. Do not fall
      // back to the panel's current session here: the sidebar uses this call
      // precisely to leave the current session and start a fresh one.
      const requested = record(args)?.sessionId
      const created = typeof requested === 'string' && requested.length > 0 ? requested : crypto.randomUUID()
      this.createdSessionId = created
      return { ok: true, value: { sessionId: created } }
    }
    if (endpoint === 'session/rename' || endpoint === 'session/selectModel' || endpoint === 'session/updateQueue') {
      if (endpoint === 'session/rename') {
        const title = String(record(args)?.title ?? '').trim()
        if (sessionId && title) this.propsRef.current.onRename?.(sessionId, title)
        return { ok: true, value: { title, seq: 0 } }
      }
      if (endpoint === 'session/selectModel') {
        const model = String(record(args)?.model ?? this.propsRef.current.model?.trim() ?? 'deepseek-v4-flash')
        this.propsRef.current.onSelectModel?.(model)
        return { ok: true, value: { selected: { provider: 'deepseek', model } } }
      }
      if (endpoint === 'session/updateQueue') {
        const itemId = String(record(args)?.itemId ?? '')
        const action = record(record(args)?.action)
        if (sessionId && itemId && action?.kind === 'remove') this.propsRef.current.onQueueUpdate?.(sessionId, itemId, { kind: 'remove' })
        else if (sessionId && itemId && action?.kind === 'steer') this.propsRef.current.onQueueUpdate?.(sessionId, itemId, { kind: 'steer' })
        else if (sessionId && itemId && action?.kind === 'edit') {
          const content = Array.isArray(action.content) ? action.content : []
          const text = content.filter((item) => record(item)?.type === 'text').map((item) => String(record(item)?.text ?? '')).join('').trim()
          if (text) this.propsRef.current.onQueueUpdate?.(sessionId, itemId, { kind: 'edit', text })
        }
        return { ok: true, value: { accepted: true } }
      }
      return { ok: true, value: { accepted: true } }
    }
    return failure('gateway/unsupported', `桌面端未实现官方 Remote：${endpoint}`)
  }

  async fileUpload(path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith('/api/session/uploadFileBinary')) return new Response('unsupported upload route', { status: 404 })
    const url = new URL(path, window.location.origin)
    const name = url.searchParams.get('name') || '附件'
    const body = init.body
    if (!(body instanceof Blob)) return new Response('upload body must be a Blob', { status: 400 })
    const file = new File([await body.arrayBuffer()], name, { type: body.type || 'application/octet-stream' })
    const imported = await importPastedFile(file)
    const attachment = imported.attachments[0]
    if (!attachment) return new Response(JSON.stringify({ ok: false, error: { code: 'session/attachment-invalid', message: '附件未能保存', details: {} } }), { status: 200, headers: { 'content-type': 'application/json' } })
    const receiptId = crypto.randomUUID()
    this.receipts.set(receiptId, attachment)
    return new Response(JSON.stringify({ ok: true, value: { receiptId, file: { attachmentId: attachment.id, name: attachment.name, bytes: file.size } } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  private readonly receipts = new Map<string, LocalTaskAttachment>()

  private async promptAttachments(args: unknown): Promise<LocalTaskAttachment[]> {
    const content = record(args)?.content
    if (!Array.isArray(content)) return []
    const attachments: LocalTaskAttachment[] = []
    for (const item of content) {
      const value = record(item)
      if (value?.type === 'file' && typeof value.receiptId === 'string') {
        const attachment = this.receipts.get(value.receiptId)
        if (attachment) attachments.push(attachment)
      } else if (value?.type === 'image' && typeof value.data === 'string') {
        const mediaType = typeof value.mediaType === 'string' ? value.mediaType : 'image/png'
        const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0))
        const name = typeof value.name === 'string' && value.name ? value.name : `image-${crypto.randomUUID()}.png`
        const imported = await importPastedImage(new File([bytes], name, { type: mediaType }))
        attachments.push(...imported.attachments)
      }
    }
    return attachments
  }

  private async *openEndpoint(endpoint: string, args: unknown, signal: AbortSignal): AsyncIterable<unknown> {
    if (endpoint === 'session/follow') {
      const sessionId = addressSessionId(args) ?? this.sessionId(args)
      const records = await this.records(sessionId, args)
      const cursor = records.reduce<number>((latest, record) => Math.max(latest, eventSeq(record)), -1)
      const inspection = sessionId && this.propsRef.current.employeeId ? await inspectHarnessSession(this.propsRef.current.employeeId, sessionId) : undefined
      yield { type: 'snapshot', header: { version: 4, id: sessionId ?? '', createdAt: Date.now(), isSeeded: false }, cursor, records, hasMore: false, projections: { ...projectionBaseline(inspection), asOfSeq: cursor } }
      yield* this.notificationEvents(sessionId, signal)
      return
    }
    if (endpoint === 'session/control') {
      const sessionId = this.sessionId(args)
      const inspection = sessionId && this.propsRef.current.employeeId ? await inspectHarnessSession(this.propsRef.current.employeeId, sessionId) : undefined
      yield { type: 'baseline', value: { projections: sessionId ? { [sessionId]: projectionBaseline(inspection) } : {} } }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return
    }
    throw new Error(`桌面端未实现官方 Remote 流：${endpoint}`)
  }

  private async *notificationEvents(sessionId: string | undefined, signal: AbortSignal): AsyncIterable<unknown> {
    if (!isTauriRuntime() || !sessionId || this.disposed) return
    const queue: Record<string, unknown>[] = []
    let wake: (() => void) | undefined
    const unlisten = await listen<HarnessNotification>('xiaoyin://harness-notification', ({ payload }) => {
      const event = record(record(payload)?.event)
      const wire = record(event?.event)
      const params = record(wire?.params)
      if (params?.sessionId !== sessionId) return
      const value = record(params?.event)
      if (!value || typeof value.type !== 'string') return
      queue.push({ type: 'event', event: value })
      wake?.(); wake = undefined
    })
    this.listeners.add(unlisten)
    try {
      while (!signal.aborted && !this.disposed) {
        const value = queue.shift()
        if (value) { yield value; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      unlisten()
      this.listeners.delete(unlisten)
    }
  }

  private async records(sessionId: string | undefined, args?: unknown): Promise<unknown[]> {
    if (!sessionId || !this.propsRef.current.employeeId) return []
    const inspection = await inspectHarnessSession(this.propsRef.current.employeeId, sessionId)
    const records = (inspection?.events ?? []).map((event) => ({ type: 'event', event }))
    const maxMessages = record(args)?.maxMessages
    return Number.isSafeInteger(maxMessages) && Number(maxMessages) > 0 ? records.slice(-Number(maxMessages)) : records
  }

  private createdSessionId?: string

  private sessionId(args: unknown): string | undefined {
    const item = record(args)
    return typeof item?.sessionId === 'string' ? item.sessionId : this.propsRef.current.sessionId ?? this.createdSessionId
  }
}

function bootGraph() {
  const ids = [
    'dsh-client-modules', 'dsh-client-connection', 'dsh-typert-registry', 'dsh-api-gateway', 'dsh-api-remotes',
    'dsh-client-file-upload', 'dsh-client-locale', 'dsh-client-ui-settings', 'dsh-client-ui-renderer', 'dsh-client-resources',
    'dsh-client-ui-theme', 'dsh-client-shortcuts', 'dsh-api-workspace-controller', 'dsh-api-session-controller',
    'dsh-client-ui-session', 'dsh-client-ui-layout', 'dsh-client-ui-sidebar', 'dsh-client-ui-sidebar-right',
    'dsh-client-ui-sidebar-browser',
    'dsh-client-ui-workspace', 'dsh-client-ui-conversation', 'dsh-client-ui-input-trigger', 'dsh-client-ui-chat',
    'dsh-client-ui-tool', 'dsh-client-ui-approval', 'dsh-client-ui-user-questions', 'dsh-client-ui-trajectory',
  ]
  const entries = ids.map((id) => ({ id: `@deepseek-ai/${id}`, url: `local:${id}`, initialUrl: `local:${id}`, rev: 'local', inject: [], external: [] }))
  return {
    rev: 'local',
    entries: entries.map(({ id, inject }) => ({ id, url: `local:${id}`, rev: 'local', inject, immediately: true })),
    batches: [{ phase: 'application' as const, url: 'local:official', rev: 'local', entries: entries.map((entry) => entry.id) }],
  }
}

function summary(sessionId: string, inspection: { status?: string; updatedAt?: string; projection?: unknown } | undefined, reference?: { label: string; updatedAt: string }) {
  return {
    sessionId,
    updatedAt: inspection?.updatedAt ? Date.parse(inspection.updatedAt) : reference?.updatedAt ? Date.parse(reference.updatedAt) : Date.now(),
    running: inspection?.status === 'running',
    blank: false,
    agentAvailable: true,
    projections: projectionBaseline(inspection),
  }
}

function projectionBaseline(inspection: { projection?: unknown } | undefined) {
  const values: Record<string, unknown> = { sessionListMetadata: { blank: false, lastPromptAt: null } }
  if (inspection?.projection && typeof inspection.projection === 'object') values['xiaoyin.product'] = inspection.projection
  return { kind: 'cached' as const, asOfSeq: -1, values }
}

function promptText(args: unknown): string | undefined {
  const content = record(args)?.content
  if (!Array.isArray(content)) return undefined
  return content.filter((item): item is Record<string, unknown> => record(item)?.type === 'text').map((item) => String(item.text ?? '')).join('')
}

function promptMode(args: unknown): 'queue' | 'steer' {
  return record(args)?.mode === 'steer' ? 'steer' : 'queue'
}

function addressSessionId(args: unknown): string | undefined {
  const address = record(args)?.address
  const value = record(address)
  if (value?.kind === 'session' && typeof value.sessionId === 'string') return value.sessionId
  if (value?.kind === 'subagent' && typeof value.childSessionId === 'string') return value.childSessionId
  return undefined
}

function eventSeq(recordValue: unknown): number {
  const event = record(recordValue)?.event
  return Number.isSafeInteger(event?.seq) ? Number(event.seq) : -1
}

function failure(code: string, message: string) {
  return { ok: false as const, error: { code, message, details: {} } }
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}
