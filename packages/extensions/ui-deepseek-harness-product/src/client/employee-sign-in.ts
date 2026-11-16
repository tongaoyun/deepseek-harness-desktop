/** Route employee authorization to the persistent sidebar launcher. */
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Open the product's employee authorization screen.
     * @mode emit
     * @param returnFocus Recover lost focus through the requesting view's current controls when the sidebar is hidden.
     */
    'deepseek-harness/sign-in'(returnFocus?: () => void): void
  }
}

/** Shared login entry and its launcher-owned subscription. */
export interface EmployeeSignInActions {
  /** Open login without changing the draft; optionally recover lost focus when the sidebar cannot receive it. */
  readonly openEmployeeSignIn: (returnFocus?: () => void) => void
  /** Subscribe the persistent launcher to login requests. */
  readonly subscribeEmployeeSignIn: (listener: (returnFocus?: () => void) => void) => () => void
}

/** Bind product login requests to the native client event lifecycle.
 * @param ctx Product plugin context.
 * @returns Callbacks shared by the sidebar and enterprise resource views.
 */
export function createEmployeeSignInActions(ctx: Context): EmployeeSignInActions {
  return {
    openEmployeeSignIn: (returnFocus) => { ctx.emit('deepseek-harness/sign-in', returnFocus) },
    subscribeEmployeeSignIn: listener => ctx.on('deepseek-harness/sign-in', listener),
  }
}
