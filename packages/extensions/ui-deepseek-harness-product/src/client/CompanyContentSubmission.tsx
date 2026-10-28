/** Employee sharing of native documents; the main process owns authentication and upload. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import { productApi } from './product-api.ts'
import css from '../DeepSeekHarnessProduct.module.css'

interface Candidate { resourceKey: string; files: Record<string, string> }
interface Intent { name: string; prepare: (signal: AbortSignal) => Promise<Candidate> }
interface Status { status: 'SUBMITTED' | 'PUBLISHED' | 'REJECTED'; reviewNote: string }
function statusOf(value: unknown, invalidMessage: string): Status {
  if (typeof value !== 'object' || value === null || !('status' in value)
    || (value.status !== 'SUBMITTED' && value.status !== 'PUBLISHED' && value.status !== 'REJECTED')
    || !('reviewNote' in value) || typeof value.reviewNote !== 'string') throw new Error(invalidMessage)
  return { status: value.status, reviewNote: value.reviewNote }
}

/** Own preparation and submission; only inspection may report no existing submission. */
export function CompanyContentSubmission({ t }: PropsLocale<typeof NS>) {
  const [intent, setIntent] = useState<Intent>()
  const [candidate, setCandidate] = useState<Candidate>()
  const [status, setStatus] = useState<Status | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState('')
  const operation = useRef<AbortController>()
  const writing = useRef(false)
  const translate = useRef(t)
  translate.current = t
  const close = () => { if (writing.current) return; operation.current?.abort(); setIntent(undefined); setCandidate(undefined); setError('') }
  useEffect(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.defaultPrevented || writing.current) return
      const detail: unknown = event.detail
      if (typeof detail !== 'object' || !detail || !('name' in detail) || typeof detail.name !== 'string'
        || !('prepare' in detail) || typeof detail.prepare !== 'function') return
      event.preventDefault()
      // This is an in-process UI callback; only the resulting files cross IPC and are validated there.
      const next = detail as Intent
      const api = productApi()
      if (!api) return
      operation.current?.abort()
      const controller = new AbortController(); operation.current = controller
      const requestId = randomUUID()
      controller.signal.addEventListener('abort', () => { api.cancel(requestId) }, { once: true })
      setIntent(next); setCandidate(undefined); setStatus(null); setError(''); setWorking(true)
      void next.prepare(controller.signal).then(async (value) => {
        controller.signal.throwIfAborted()
        const inspected = await api.invoke('content.submissions.inspect', value, requestId, 120_000)
        controller.signal.throwIfAborted()
        if (typeof inspected !== 'object' || !inspected || !('status' in inspected)) throw new Error(translate.current('companySubmitFailed'))
        setStatus(inspected.status === null ? null : statusOf(inspected.status, translate.current('companySubmitFailed'))); setCandidate(value)
      }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : translate.current('companySubmitFailed')) })
        .finally(() => { if (!controller.signal.aborted) setWorking(false) })
    }
    const api = productApi()
    let live = true
    let identity: string | undefined
    const updateIdentity = (session: Awaited<ReturnType<NonNullable<typeof api>['getSession']>>, changed = false) => {
      const next = JSON.stringify([session.authenticated, session.employeeId])
      if (identity === undefined ? changed : next !== identity) {
        operation.current?.abort(); writing.current = false; setWorking(false); setIntent(undefined); setCandidate(undefined)
      }
      identity = next
    }
    const unsubscribe = api?.subscribe((event) => {
      const value = event.payload
      if (event.type !== 'session.changed' || typeof value !== 'object' || value === null
        || !('authenticated' in value) || typeof value.authenticated !== 'boolean') return
      updateIdentity({ authenticated: value.authenticated,
        ...'employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {} }, true)
    })
    void api?.getSession().then((session) => { if (live && identity === undefined) updateIdentity(session) }).catch(() => {
      // Identity events remain authoritative if the initial session read fails.
    })
    document.addEventListener('dsh:company-content-submit', receive)
    return () => { live = false; document.removeEventListener('dsh:company-content-submit', receive); unsubscribe?.(); operation.current?.abort() }
  }, [])
  const submit = async () => {
    if (!candidate || writing.current) return
    const api = productApi(); if (!api) return
    writing.current = true; setWorking(true); setError('')
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller
    const requestId = randomUUID()
    controller.signal.addEventListener('abort', () => { api.cancel(requestId) }, { once: true })
    try {
      const result = await api.invoke('content.submissions.submit', candidate, requestId, 120_000)
      controller.signal.throwIfAborted(); setStatus(statusOf(result, t('companySubmitFailed')))
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('companySubmitFailed')) }
    finally { if (operation.current === controller) { writing.current = false; if (!controller.signal.aborted) setWorking(false) } }
  }
  if (!intent) return null
  return <Modal open onClose={close} title={t('companySubmitTitle')} closeLabel={t('close')}
    className={css.feedbackModal as string} footer={<>
      <Button onClick={close} disabled={writing.current}>{t('close')}</Button>
      <Button variant="primary" disabled={working || !candidate || status !== null} onClick={() => void submit()}>{working ? t('companySubmitWorking') : t('companySubmitTitle')}</Button>
    </>}>
    <div className={css.feedbackBody}>
      <strong>{intent.name}</strong><p>{t('companySubmitHint')}</p>
      {working && <p role="status">{t('companySubmitWorking')}</p>}
      {candidate && <p>{t('companySubmitFiles', { count: Object.keys(candidate.files).length })}</p>}
      {status && <p role="status">{t(status.status === 'SUBMITTED' ? 'companySubmitted' : status.status === 'PUBLISHED' ? 'companyPublished' : 'companyRejected')}</p>}
      {status?.reviewNote && <p>{status.reviewNote}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>
}
