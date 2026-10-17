/**
 * Application mount through a dependency fiber, so replacing `uiRenderer`
 * remounts the application. Shared by `AppWebEntry` and the test carrier.
 * @module @deepseek-ai/dsh-client-web/src/mount
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientEntries } from '@deepseek-ai/dsh-client-modules/client'
import { BootPage } from './boot-page.ts'

/**
 * Mount the UI renderer into `container` through a dependency fiber on
 * `uiRenderer`. Entry reconciliation unmounts the root before plugin teardown
 * and remounts it after activation; failures remain on the framework-free page.
 * @param ctx - booted root Context.
 * @param container - application mount point.
 * @param entries - Page-owned plugin reconciliation state.
 * @returns resolves once the dependency fiber exists; with `uiRenderer`
 * already provided (as after `bootClient`) the mount effect is installed by
 * then, otherwise it installs when the service arrives.
 */
export async function mountClient(ctx: Context, container: HTMLElement, entries: Pick<ClientEntries, 'state'>): Promise<void> {
  const mounted = ctx.inject(['uiRenderer'], (scope) => {
    scope.effect(() => {
      let unmount: (() => void) | undefined
      let page: BootPage | undefined
      const update = () => {
        const state = entries.state.getSnapshot()
        if (state.syncing || state.failures.length > 0) {
          unmount?.(); unmount = undefined
          page?.dispose(); page = new BootPage(container)
          if (state.failures.length > 0) page.fail(state.failures.map(row => `${row.id}: ${row.message}`).join('\n'))
          return
        }
        page?.dispose(); page = undefined
        unmount ??= scope.uiRenderer.mount(container)
      }
      const unsubscribe = entries.state.subscribe(update)
      try { update() } catch (error) { unsubscribe(); page?.dispose(); throw error }
      return () => { unsubscribe(); unmount?.(); page?.dispose() }
    }, 'web boot: application mount')
  })
  await mounted
}
