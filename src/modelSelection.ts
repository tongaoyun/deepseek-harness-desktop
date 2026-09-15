export function resolveSelectedModel(models: string[], stored?: string | null): string {
  const available = availableModels(models)
  if (stored && available.includes(stored)) return stored
  return available[0] ?? ''
}

export function availableModels(models: string[]): string[] {
  return [...new Set(models)].filter((model) => !['gpt-5.6', '5.6'].includes(model.trim().toLowerCase()))
}

export function modelDisplayName(model: string): string {
  return model
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'gpt' ? 'GPT' : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

export function modelStorageKey(employeeId: string): string {
  return `xiaoyin.selected-model.${employeeId}`
}

export function loadSelectedModel(employeeId: string): string | null {
  try { return localStorage.getItem(modelStorageKey(employeeId)) }
  catch { return null }
}

export function saveSelectedModel(employeeId: string, model: string): boolean {
  try {
    localStorage.setItem(modelStorageKey(employeeId), model)
    return localStorage.getItem(modelStorageKey(employeeId)) === model
  } catch { return false }
}
