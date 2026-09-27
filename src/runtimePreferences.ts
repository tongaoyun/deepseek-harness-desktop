const SHELL_KEY = 'allow-shell'
const LSP_KEY = 'allow-lsp'
const EXTERNAL_AGENTS_KEY = 'allow-external-agents'
const HOOKS_KEY = 'allow-hooks'

function preferenceKey(owner: string, key: string): string | undefined {
  const normalized = owner.trim()
  return normalized ? `xiaoyin.runtime.${encodeURIComponent(normalized)}.${key}` : undefined
}

function readPreference(owner: string, key: string): string | null | undefined {
  const storageKey = preferenceKey(owner, key)
  if (!storageKey) return undefined
  try { return typeof localStorage === 'undefined' ? undefined : localStorage.getItem(storageKey) }
  catch { return undefined }
}

function writePreference(owner: string, key: string, value: string): boolean {
  const storageKey = preferenceKey(owner, key)
  if (!storageKey) return false
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(storageKey, value)
    return localStorage.getItem(storageKey) === value
  } catch { return false }
}

/** Shell and persistent terminal share one explicit local authorization boundary. */
export function loadHarnessShellEnabled(owner: string): boolean {
  const value = readPreference(owner, SHELL_KEY)
  return value === null || value === 'true'
}

export function saveHarnessShellEnabled(owner: string, value: boolean): boolean {
  return writePreference(owner, SHELL_KEY, String(value))
}

export function loadHarnessLspEnabled(owner: string): boolean {
  return readPreference(owner, LSP_KEY) === 'true'
}

export function saveHarnessLspEnabled(owner: string, value: boolean): boolean {
  return writePreference(owner, LSP_KEY, String(value))
}

export function loadHarnessExternalAgentsEnabled(owner: string): boolean {
  return readPreference(owner, EXTERNAL_AGENTS_KEY) === 'true'
}

export function saveHarnessExternalAgentsEnabled(owner: string, value: boolean): boolean {
  return writePreference(owner, EXTERNAL_AGENTS_KEY, String(value))
}

export function loadHarnessHooksEnabled(owner: string): boolean {
  return readPreference(owner, HOOKS_KEY) === 'true'
}

export function saveHarnessHooksEnabled(owner: string, value: boolean): boolean {
  return writePreference(owner, HOOKS_KEY, String(value))
}
