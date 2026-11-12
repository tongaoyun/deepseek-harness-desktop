/** Employee sharing of native documents; the main process owns authentication and upload. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from '../locales.ts'
import { invokeProduct, productApi } from './product-api.ts'
import { productErrorMessage, type ProductFailureReport } from './product-errors.ts'
import css from '../DeepSeekHarnessProduct.module.css'

interface Candidate { resourceKey: string; files: Record<string, string> }
interface Intent { name: string; prepare: (signal: AbortSignal) => Promise<Candidate> }
interface Status { status: 'SUBMITTED' | 'PUBLISHED' | 'REJECTED'; reviewNote: string }
function statusOf(value: unknown): Status {
  if (typeof value !== 'object' || value === null || !('status' in value)
    || (value.status !== 'SUBMITTED' && value.status !== 'PUBLISHED' && value.status !== 'REJECTED')
    || !('reviewNote' in value) || typeof value.reviewNote !== 'string') throw new Error('Invalid submission status')
  return { status: value.status, reviewNote: value.reviewNote }
}

/** Confirm content before submission; retries retain focus and confirmed review status hands owned action focus to Close. */
export function CompanyContentSubmission({ t }: PropsLocale<typeof NS>) {
  const [intent, setIntent] = useState<Intent>()
  const [candidate, setCandidate] = useState<Candidate>()
  const [status, setStatus] = useState<Status | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<ProductFailureReport | null>(null)
  const operation = useRef<AbortController>()
  const writing = useRef(false)
  const actionRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const acceptStatus = useCallback((next: Status | null) => {
    const action = actionRef.current
    if (next && action && action.ownerDocument.activeElement === action && closeRef.current) {
      focusWithoutRing(closeRef.current, { preventScroll: true })
    }
    setStatus(next)
  }, [])
  const close = () => {
    if (writing.current) return
    operation.current?.abort(); setIntent(undefined); setCandidate(undefined); setError(null)
  }
  const prepare = useCallback((next: Intent, retry = false) => {
    if (writing.current || retry && operation.current && !operation.current.signal.aborted) return
    const api = productApi()
    if (!api) return
    operation.current?.abort()
    const controller = new AbortController(); operation.current = controller
    setIntent(next); setCandidate(undefined); setStatus(null); setWorking(true)
    if (!retry) setError(null)
    void (async () => {
      const value = await next.prepare(controller.signal)
      controller.signal.throwIfAborted()
      const inspected = await invokeProduct(api, 'content.submissions.inspect', value, controller.signal, 120_000)
      controller.signal.throwIfAborted()
      if (typeof inspected !== 'object' || !inspected || !('status' in inspected)) throw new Error('Invalid submission inspection')
      acceptStatus(inspected.status === null ? null : statusOf(inspected.status)); setCandidate(value); setError(null)
    })().catch((failure: unknown) => { if (!controller.signal.aborted) setError({ failure, fallback: 'companySubmitFailed' }) })
      .finally(() => {
        if (operation.current !== controller) return
        operation.current = undefined
        if (!controller.signal.aborted) setWorking(false)
      })
  }, [acceptStatus])
  useEffect(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.defaultPrevented || writing.current) return
      const detail: unknown = event.detail
      if (typeof detail !== 'object' || !detail || !('name' in detail) || typeof detail.name !== 'string'
        || !('prepare' in detail) || typeof detail.prepare !== 'function') return
      event.preventDefault()
      // This is an in-process UI callback; only the resulting files cross IPC and are validated there.
      const next = detail as Intent
      prepare(next)
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
  }, [prepare])
  const submit = async () => {
    if (!candidate || status !== null || writing.current) return
    const api = productApi(); if (!api) return
    writing.current = true; setWorking(true)
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller
    try {
      const result = await invokeProduct(api, 'content.submissions.submit', candidate, controller.signal, 120_000)
      controller.signal.throwIfAborted(); acceptStatus(statusOf(result)); setError(null)
    } catch (failure) { if (!controller.signal.aborted) setError({ failure, fallback: 'companySubmitFailed' }) }
    finally { if (operation.current === controller) { writing.current = false; if (!controller.signal.aborted) setWorking(false) } }
  }
  if (!intent) return null
  return <Modal open onClose={close} title={t('companySubmitTitle')} closeLabel={t('close')}
    className={css.feedbackModal as string} footer={<>
      <Button ref={closeRef} onClick={close} aria-disabled={writing.current} className={writing.current ? 'product-control-pending' : undefined}>{t('close')}</Button>
      {error && !candidate ? <Button ref={actionRef} variant="primary" aria-disabled={working} aria-busy={working}
        className={working ? 'product-control-pending' : undefined} onClick={() => { prepare(intent, true) }}>{t('retry')}</Button>
        : <Button ref={actionRef} variant="primary" disabled={!candidate || status !== null} aria-disabled={working || !candidate || status !== null} aria-busy={working}
          className={working && candidate && status === null ? 'product-control-pending' : undefined}
          onClick={() => void submit()}>{working ? t('companySubmitWorking') : t('companySubmitTitle')}</Button>}
    </>}>
    <div className={css.feedbackBody}>
      <strong>{intent.name}</strong><p>{t('companySubmitHint')}</p>
      {candidate && <p>{t('companySubmitFiles', { count: Object.keys(candidate.files).length })}</p>}
      {status && <p role="status">{t(status.status === 'SUBMITTED' ? 'companySubmitted' : status.status === 'PUBLISHED' ? 'companyPublished' : 'companyRejected')}</p>}
      {status?.reviewNote && <p>{status.reviewNote}</p>}
      {error && <p role="alert">{productErrorMessage(error.failure, t, error.fallback)}</p>}
    </div>
  </Modal>
}
