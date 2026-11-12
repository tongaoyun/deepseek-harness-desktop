/** Route employee authorization to the persistent sidebar launcher. */
import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Open the product's employee authorization dialog.
     * @mode emit
     */
    'deepseek-harness/sign-in'(): void
  }
}

/** Shared login entry and its launcher-owned subscription. */
export interface EmployeeSignInActions {
  /** Open the employee login dialog without navigating or changing the current draft. */
  readonly openEmployeeSignIn: () => void
  /** Subscribe the persistent launcher to login requests. */
  readonly subscribeEmployeeSignIn: (listener: () => void) => () => void
}

/** Bind product login requests to the native client event lifecycle.
 * @param ctx Product plugin context.
 * @returns Callbacks shared by the sidebar and enterprise resource views.
 */
export function createEmployeeSignInActions(ctx: Context): EmployeeSignInActions {
  return {
    openEmployeeSignIn: () => { ctx.emit('deepseek-harness/sign-in') },
    subscribeEmployeeSignIn: listener => ctx.on('deepseek-harness/sign-in', listener),
  }
}
