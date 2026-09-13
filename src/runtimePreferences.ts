export type HarnessToolsMode = 'native' | 'ptc' | 'both'

const TOOLS_MODE_KEY = 'xiaoyin.runtime.tools-mode'
const SHELL_KEY = 'xiaoyin.runtime.allow-shell'
const LSP_KEY = 'xiaoyin.runtime.allow-lsp'
const EXTERNAL_AGENTS_KEY = 'xiaoyin.runtime.allow-external-agents'
const HOOKS_KEY = 'xiaoyin.runtime.allow-hooks'

function readPreference(key: string): string | null | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage.getItem(key) }
  catch { return undefined }
}

function writePreference(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return localStorage.getItem(key) === value
  } catch { return false }
}

export function loadHarnessToolsMode(): HarnessToolsMode {
  const value = readPreference(TOOLS_MODE_KEY)
  return value === 'ptc' || value === 'both' ? value : 'native'
}

export function saveHarnessToolsMode(value: HarnessToolsMode): boolean {
  return writePreference(TOOLS_MODE_KEY, value)
}

/** Shell and persistent terminal share one explicit local authorization boundary. */
export function loadHarnessShellEnabled(): boolean {
  const value = readPreference(SHELL_KEY)
  return value === null || value === 'true'
}

export function saveHarnessShellEnabled(value: boolean): boolean {
  return writePreference(SHELL_KEY, String(value))
}

export function loadHarnessLspEnabled(): boolean {
  const value = readPreference(LSP_KEY)
  return value === null || value === 'true'
}

export function saveHarnessLspEnabled(value: boolean): boolean {
  return writePreference(LSP_KEY, String(value))
}

export function loadHarnessExternalAgentsEnabled(): boolean {
  return readPreference(EXTERNAL_AGENTS_KEY) === 'true'
}

export function saveHarnessExternalAgentsEnabled(value: boolean): boolean {
  return writePreference(EXTERNAL_AGENTS_KEY, String(value))
}

export function loadHarnessHooksEnabled(): boolean {
  return readPreference(HOOKS_KEY) === 'true'
}

export function saveHarnessHooksEnabled(value: boolean): boolean {
  return writePreference(HOOKS_KEY, String(value))
}
