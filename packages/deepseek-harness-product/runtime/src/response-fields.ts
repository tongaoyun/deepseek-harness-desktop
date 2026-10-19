/** Field readers for product directory and connector wire responses. */
/** Require an object from a remote directory entry.
 * @param value Untrusted response entry.
 * @param label Resource used in the validation diagnostic.
 * @returns The entry with unknown field values.
 */
export function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`deepseek-harness product: invalid ${label}`)
  }
  return value as Record<string, unknown>
}

/** Read a required nonempty string from a remote entry.
 * @param record Validated object entry.
 * @param field Required field name.
 * @returns The nonempty string, or throws for malformed data.
 */
export function stringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value === '') throw new Error(`deepseek-harness product: invalid ${field}`)
  return value
}

/** Read a directory list containing only nonempty strings.
 * @param value Untrusted field value.
 * @param field Field used in the validation diagnostic.
 * @returns An owned list, or throws for malformed data.
 */
export function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`deepseek-harness product: invalid ${field}`)
  }
  return value.map(item => String(item))
}
