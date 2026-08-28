export function resolveSelectedModel(models: string[], stored?: string | null): string {
  if (stored && models.includes(stored)) return stored
  return models[0] ?? 'deepseek-v4-flash'
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
