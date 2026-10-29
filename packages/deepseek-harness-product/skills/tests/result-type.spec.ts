import { expect, it } from 'vitest'
import { skillResultType } from '../scripts/result-type.ts'

it.each([
  ['/workspace/skills/', '/workspace/skills/src/'],
  ['D:\\a\\skills\\', 'D:/a/skills/src/'],
])('emits portable result imports for %s', (root, prefix) => {
  expect(skillResultType(`{ roots: import("${prefix}types", { with: { "resolution-mode": "import" } }).RootView[]; row: import("${prefix}core").WorkspaceRow; }`, root))
    .toBe('{ roots: import("../types.ts").RootView[]; row: import("../core.ts").WorkspaceRow; }')
})
