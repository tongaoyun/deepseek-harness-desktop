/** Display-name suggestions for editable expert and team copies. */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Reserve room for the copy suffix and avoid existing names using save-time normalization.
 * @param original - Source display name.
 * @param suffix - Localized suffix including its leading separator.
 * @param existing - Names already present in the resource directory.
 * @returns Unused name within the editors' 40 UTF-16 code-unit limit, without splitting a grapheme.
 */
export function customCopyName(original: string, suffix: string, existing: readonly string[]): string {
  const taken = new Set(existing.map(name => name.trim().toLowerCase()))
  for (let index = 1; ; index++) {
    const ending = index === 1 ? suffix : `${suffix} ${index}`
    let stem = ''
    for (const { segment } of segmenter.segment(original.trim())) {
      if (stem.length + segment.length + ending.length > 40) break
      stem += segment
    }
    const name = `${stem.trimEnd()}${ending}`.trim()
    if (!taken.has(name.toLowerCase())) return name
  }
}
