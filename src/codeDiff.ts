import { diffLines } from 'diff'

export interface CodeDiffRow {
  id: string
  kind: 'context' | 'added' | 'removed' | 'fold'
  text: string
  oldLine?: number
  newLine?: number
  foldedLines?: number
}

const CONTEXT_LINES = 4

export function codeDiffRows(previous: string, current: string, expandedFolds: ReadonlySet<string> = new Set()): CodeDiffRow[] {
  let oldLine = 1
  let newLine = 1
  const rows: CodeDiffRow[] = []
  for (const [partIndex, part] of diffLines(previous, current).entries()) {
    const lines = contentLines(part.value)
    if (!part.added && !part.removed && lines.length > CONTEXT_LINES * 2 + 2 && !expandedFolds.has(`${partIndex}:fold`)) {
      appendLines(rows, lines.slice(0, CONTEXT_LINES), 'context', partIndex, oldLine, newLine)
      oldLine += CONTEXT_LINES
      newLine += CONTEXT_LINES
      const foldedLines = lines.length - CONTEXT_LINES * 2
      rows.push({ id: `${partIndex}:fold`, kind: 'fold', text: '', foldedLines })
      oldLine += foldedLines
      newLine += foldedLines
      appendLines(rows, lines.slice(-CONTEXT_LINES), 'context', partIndex, oldLine, newLine, lines.length - CONTEXT_LINES)
      oldLine += CONTEXT_LINES
      newLine += CONTEXT_LINES
      continue
    }
    const kind = part.added ? 'added' : part.removed ? 'removed' : 'context'
    appendLines(rows, lines, kind, partIndex, oldLine, newLine)
    if (!part.added) oldLine += lines.length
    if (!part.removed) newLine += lines.length
  }
  return rows
}

function appendLines(
  rows: CodeDiffRow[],
  lines: string[],
  kind: CodeDiffRow['kind'],
  partIndex: number,
  oldStart: number,
  newStart: number,
  offset = 0,
): void {
  lines.forEach((text, index) => rows.push({
    id: `${partIndex}:${offset + index}:${kind}`,
    kind,
    text,
    ...((kind === 'added') ? {} : { oldLine: oldStart + index }),
    ...((kind === 'removed') ? {} : { newLine: newStart + index }),
  }))
}

function contentLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
