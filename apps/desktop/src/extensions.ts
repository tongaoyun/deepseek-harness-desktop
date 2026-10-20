/** Trusted application assembly hooks; business protocols live in extension packages. */
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export interface DesktopExtensionContext {
  readonly getWindow: () => BrowserWindow | undefined
  readonly isQuitting: () => boolean
  readonly requestHost: (namespace: string, method: string, payload?: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<unknown>
}

export interface DesktopExtension {
  readonly namespace: string
  readonly ownsStartupDocument: boolean
  prepareHost(profile: { readonly directory: string; readonly installAnchor: string }): Promise<NodeJS.ProcessEnv | undefined>
  invoke(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  invokeRuntime(method: unknown, payload?: unknown, signal?: AbortSignal): Promise<unknown>
  subscribe(listener: (event: unknown) => void): () => void
  focus(): Promise<void>
  close(): Promise<void>
}

/** No configured assembly leaves the official desktop profile independent. */
export async function loadDesktopExtension(
  context: DesktopExtensionContext, resources?: { readonly root: string; readonly runtime: string },
): Promise<DesktopExtension | undefined> {
  let specifier = process.env.DSH_DESKTOP_EXTENSION
  const descriptor = resources === undefined ? undefined : join(resources.root, 'desktop-extension.json')
  if (specifier === undefined && resources !== undefined && descriptor !== undefined && existsSync(descriptor)) {
    const value: unknown = JSON.parse(readFileSync(descriptor, 'utf8'))
    if (typeof value !== 'object' || value === null || !('module' in value) || typeof value.module !== 'string') throw new Error('Invalid Desktop extension descriptor')
    specifier = pathToFileURL(createRequire(join(resources.runtime, 'package.json')).resolve(value.module)).href
  }
  if (specifier === undefined) return undefined
  const module: unknown = await import(specifier)
  if (typeof module !== 'object' || module === null || !('createExtension' in module) || typeof module.createExtension !== 'function') {
    throw new Error('Desktop extension must export createExtension')
  }
  const createExtension = module.createExtension as (context: DesktopExtensionContext) => unknown
  const extension = await createExtension(context)
  if (typeof extension !== 'object' || extension === null || !('namespace' in extension)
    || typeof extension.namespace !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(extension.namespace)) {
    throw new Error('Invalid Desktop extension namespace')
  }
  for (const method of ['prepareHost', 'invoke', 'invokeRuntime', 'subscribe', 'focus', 'close']) {
    if (typeof (extension as Record<string, unknown>)[method] !== 'function') throw new Error(`Desktop extension is missing ${method}`)
  }
  return extension as DesktopExtension
}
