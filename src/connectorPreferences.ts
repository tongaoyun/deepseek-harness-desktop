const PREFIX = 'xiaoyin.enabled-connectors.'

export function loadEnabledConnectorIds(employeeId: string): string[] {
  if (!employeeId) return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`${PREFIX}${employeeId}`) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))]
  } catch {
    return []
  }
}

export function saveEnabledConnectorIds(employeeId: string, connectorIds: Iterable<string>): string[] {
  const normalized = [...new Set(connectorIds)].sort()
  window.localStorage.setItem(`${PREFIX}${employeeId}`, JSON.stringify(normalized))
  return normalized
}
