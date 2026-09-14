export function resolveSelectedModel(models: string[], stored?: string | null): string {
  if (stored && models.includes(stored)) return stored
  return models[0] ?? ''
}

export function modelDisplayName(model: string): string {
  return model
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'deepseek'
      ? 'DeepSeek'
      : part.length <= 4 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`)
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

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export const reasoningEffortOptions: Array<{ value: ReasoningEffort; label: string; description: string }> = [
  { value: 'low', label: '轻度', description: '更快响应，适合简单任务' },
  { value: 'medium', label: '中度', description: '速度与质量平衡' },
  { value: 'high', label: '高度', description: '更充分的分析' },
  { value: 'xhigh', label: '极高', description: '复杂任务优先质量' },
  { value: 'max', label: '最大', description: '允许模型使用最多推理' },
]

export function resolveReasoningEffort(value?: string | null): ReasoningEffort {
  return reasoningEffortOptions.some((item) => item.value === value) ? value as ReasoningEffort : 'medium'
}

export function reasoningEffortLabel(value?: string | null): string {
  return reasoningEffortOptions.find((item) => item.value === resolveReasoningEffort(value))?.label ?? '中度'
}

export function reasoningStorageKey(employeeId: string): string {
  return `xiaoyin.reasoning-effort.${employeeId}`
}

export function loadReasoningEffort(employeeId: string): ReasoningEffort {
  try { return resolveReasoningEffort(localStorage.getItem(reasoningStorageKey(employeeId))) }
  catch { return 'medium' }
}

export function saveReasoningEffort(employeeId: string, value: ReasoningEffort): boolean {
  try {
    localStorage.setItem(reasoningStorageKey(employeeId), value)
    return localStorage.getItem(reasoningStorageKey(employeeId)) === value
  } catch { return false }
}
