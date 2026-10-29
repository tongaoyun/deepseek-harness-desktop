/** Shared validation primitives for external skill catalog adapters. */
export const CATALOG_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export function catalogRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function catalogCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function catalogString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text !== '' && text.length <= maxLength ? text : undefined
}

export function catalogError(message: string, statusCode: number, code: string): Error & { readonly statusCode: number; readonly code: string } {
  return Object.assign(new Error(message), { statusCode, code })
}
