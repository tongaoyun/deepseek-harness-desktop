/** Employee-authenticated file libraries use the shared product navigation shell. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import { productApi } from './product-api.ts'
import { LibraryHome, type LibraryNavigation } from './LibraryHome.tsx'
import { ProductLoading } from './ProductLoading.tsx'
import { ProductSignIn } from './ProductSignIn.tsx'
import type { EmployeeSignInActions } from './employee-sign-in.ts'
import { useResultFocus } from './useResultFocus.ts'
import css from '../DeepSeekHarnessProduct.module.css'
/** Employee events supersede pending identity reads and dispose the previous employee's reads and edits.
 * Same-employee renewal retains the directory and drafts; identity retries retain their errors and focus.
 * @param props Native main-panel locale, preview factory and sign-in action.
 * @returns Stable library heading and the authenticated directory.
 */
export function LibraryPanel(
  props: PropsLocale<typeof NS> & PropsRenderFactories & LibraryNavigation & Pick<EmployeeSignInActions, 'openEmployeeSignIn'>,
): ReactNode {
  const [identity, setIdentity] = useState<string | null>()
  const [error, setError] = useState(false)
  const [verifying, setVerifying] = useState(true)
  const [revision, setRevision] = useState(0)
  const identityRead = useRef(false)
  const root = useRef<HTMLElement | null>(null)
  const focusArea = useRef<HTMLElement | null>(null)
  const capture = useResultFocus(focusArea, () => {
    const target = root.current?.querySelector<HTMLInputElement>('input[type="search"]')
      ?? root.current?.querySelector<HTMLButtonElement>('button') ?? root.current
    if (target) focusWithoutRing(target, { preventScroll: true })
  })
  useEffect(() => {
    const api = productApi()
    let live = true, received = false
    identityRead.current = true
    setVerifying(true)
    const update = (session: Awaited<ReturnType<NonNullable<typeof api>['getSession']>>) => {
      received = true
      capture()
      setIdentity(session.authenticated && session.employeeId ? session.employeeId : null)
      setError(false)
      setVerifying(false)
      identityRead.current = false
    }
    const unsubscribe = api?.subscribe((event) => {
      const value = event.payload
      if (event.type !== 'session.changed' || typeof value !== 'object' || value === null ||
        !('authenticated' in value) || typeof value.authenticated !== 'boolean') return
      update({ authenticated: value.authenticated,
        ...('employeeId' in value && typeof value.employeeId === 'string' ? { employeeId: value.employeeId } : {}),
      })
    })
    void api?.getSession().then((session) => {
      if (live && !received) update(session)
    }).catch(() => {
      if (live && !received) {
        setError(true)
        setVerifying(false)
        identityRead.current = false
      }
    })
    if (api === undefined) {
      setError(true)
      setVerifying(false)
      identityRead.current = false
    }
    return () => {
      live = false
      unsubscribe?.()
    }
  }, [revision, capture])
  return (
    <section ref={(node) => { root.current = node; focusArea.current = node?.ownerDocument.body ?? null }}
      tabIndex={-1} className={css.catalogPage} aria-label={props.t('library')}>
      <div className={css.catalogScroll}>
        <div className="product-capability-content">
          <header className={`${css.catalogHeader} product-capability-header`}>
            <div className="product-capability-heading">
              <h1 className="product-capability-title">{props.t('library')}</h1>
              <p className="product-capability-description">{props.t('libraryHint')}</p>
            </div>
          </header>
          {identity === undefined && !error && <ProductLoading label={props.t('loading')} />}
          {error && (
            <div role="alert">
              <p>{props.t('loadFailed')}</p>
              <Button variant="outline" aria-disabled={verifying} aria-busy={verifying}
                className={verifying ? 'product-control-pending' : undefined}
                onClick={() => {
                  if (identityRead.current) return
                  identityRead.current = true
                  setVerifying(true)
                  setRevision(value => value + 1)
                }}
              >
                {props.t('retry')}
              </Button>
            </div>
          )}
          {identity === null && (
            <ProductSignIn
              t={props.t}
              onSignIn={() => {
                props.openEmployeeSignIn(() => {
                  if (root.current) focusWithoutRing(root.current, { preventScroll: true })
                })
              }}
            />
          )}
          {typeof identity === 'string' && (
            <LibraryHome key={identity} t={props.t} renderFactorySlot={props.renderFactorySlot}
              {...(props.startLibraryCreation ? { startLibraryCreation: props.startLibraryCreation } : {})}
              {...(props.openLibrarySource ? { openLibrarySource: props.openLibrarySource } : {})} />
          )}
        </div>
      </div>
    </section>
  )
}
