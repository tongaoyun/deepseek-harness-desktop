/** Keep employee-only pages behind the shared authorization screen. */
import { createContext, useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { Button, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekHarnessProductKey } from '../locales.ts'
import { productApi } from './product-api.ts'
import { ProductLoading } from './ProductLoading.tsx'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'

/** Verified employee supplied by product page composition; undefined outside that composition. */
export const EmployeeIdentity = createContext<string | undefined>(undefined)

/** Mount product content only for a verified employee; renewal preserves the same page instance.
 * @param props Page content and localized verification feedback.
 * @returns Authorized content or verification feedback; login stays in the persistent employee launcher.
 */
export function EmployeeContent({ children, t }: PropsWithChildren<{
  readonly t: (key: DeepSeekHarnessProductKey) => string
}>) {
  const [identity, setIdentity] = useState<string | null>()
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(true)
  const [retry, setRetry] = useState(0)
  const pending = useRef(true)
  const root = useRef<HTMLElement>(null)
  const capture = useResultFocus(root, () => {
    const target = root.current?.querySelector<HTMLElement>('input[type="search"]')
      ?? root.current?.querySelector<HTMLElement>('button') ?? root.current
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  useEffect(() => {
    const api = productApi()
    let live = true, received = false
    const update = (authenticated: boolean, employeeId?: string) => {
      received = true
      pending.current = false
      capture()
      setIdentity(authenticated && employeeId ? employeeId : null)
      setError(false); setChecking(false)
    }
    const unsubscribe = api?.subscribe((event) => {
      if (event.type === 'auth.required') { update(false); return }
      const value = event.payload
      if (event.type === 'session.changed' && typeof value === 'object' && value !== null
        && 'authenticated' in value && typeof value.authenticated === 'boolean') {
        update(value.authenticated, 'employeeId' in value && typeof value.employeeId === 'string' ? value.employeeId : undefined)
      }
    })
    if (!api) { pending.current = false; setError(true); setChecking(false) }
    else void api.getSession().then((session) => {
      if (live && !received) update(session.authenticated === true, session.employeeId)
    }).catch(() => {
      if (live && !received) { pending.current = false; setError(true); setChecking(false) }
    })
    return () => { live = false; unsubscribe?.() }
  }, [retry, capture])
  return <section ref={root} tabIndex={-1} className={css.catalogPage}>
    {identity && <EmployeeIdentity.Provider key={identity} value={identity}>{children}</EmployeeIdentity.Provider>}
    {identity === undefined && !error && <ProductLoading label={t('loading')} />}
    {error && <div role="alert" className={css.catalogStatus}>
      <p>{t('loadFailed')}</p>
      <Button variant="outline" aria-disabled={checking} aria-busy={checking} onClick={() => {
        if (pending.current) return
        pending.current = true
        setChecking(true); setRetry(value => value + 1)
      }}>{t('retry')}</Button>
    </div>}
  </section>
}
