import { join } from 'node:path'

/**
 * Resolve the Harness home owned by the product development launcher.
 *
 * `DSH_HOME` is intentionally ignored here: it is commonly set by an
 * already-running official Desktop shell and contains the official account
 * profile patch. `DSH_PRODUCT_HOME` is the explicit escape hatch for tests or
 * a developer who needs a different product state directory.
 */
export function resolveProductDevelopmentHome(root: string, environment: NodeJS.ProcessEnv): string {
  return environment.DSH_PRODUCT_HOME ?? join(root, 'apps/desktop/.desktop-build/product-development/home')
}

/**
 * Resolve the Electron browser/profile data owned by the product launcher.
 *
 * This must be separate from the official Desktop development userData. Electron
 * keeps the single-instance lock, cookies and renderer caches there; sharing it
 * lets an old official shell win the lock and reopen the Platform account flow.
 * `DSH_DESKTOP_USER_DATA_DIR` is intentionally ignored as an inherited value;
 * `DSH_PRODUCT_USER_DATA` is the explicit product-only override.
 */
export function resolveProductDevelopmentUserData(root: string, environment: NodeJS.ProcessEnv): string {
  return environment.DSH_PRODUCT_USER_DATA
    ?? join(root, 'apps/desktop/.desktop-build/product-development/electron-user-data')
}

/** Build the child environment without inheriting the official profile home. */
export function productDevelopmentEnvironment(
  root: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    DSH_HOME: resolveProductDevelopmentHome(root, environment),
    DSH_DESKTOP_USER_DATA_DIR: resolveProductDevelopmentUserData(root, environment),
  }
}
