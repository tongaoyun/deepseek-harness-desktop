export const reasoningLabels = { low: '轻度', medium: '标准', high: '深度', xhigh: '极深', ultra: '极致' } as const
export type ReasoningEffort = keyof typeof reasoningLabels

export function modelReasoningEfforts(model: string): ReasoningEffort[] {
  if (['gpt-6-astra', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra'].includes(model)) return ['low', 'medium', 'high', 'xhigh', 'ultra']
  if (['gpt-5.6-luna', 'gpt-5.5'].includes(model)) return ['low', 'medium', 'high', 'xhigh']
  return []
}

export function resolveReasoningEffort(model: string, value?: string | null): ReasoningEffort | undefined {
  const supported = modelReasoningEfforts(model)
  return supported.find((effort) => effort === value) ?? (supported.includes('medium') ? 'medium' : supported[0])
}

const storageKey = (owner: string, model: string) => `xiaoyin.reasoning.${owner}.${model}`
export function loadReasoningEffort(owner: string, model: string): ReasoningEffort | undefined {
  try { return resolveReasoningEffort(model, localStorage.getItem(storageKey(owner, model))) }
  catch { return resolveReasoningEffort(model) }
}
export function saveReasoningEffort(owner: string, model: string, value: ReasoningEffort): boolean {
  if (!modelReasoningEfforts(model).includes(value)) return false
  try { localStorage.setItem(storageKey(owner, model), value); return localStorage.getItem(storageKey(owner, model)) === value }
  catch { return false }
}
