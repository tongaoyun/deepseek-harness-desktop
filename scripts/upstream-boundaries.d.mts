export interface FileRevision { path: string; before: string | null; after: string | null }
export interface PatchManifest { baseline: string; patches: { id: string; purpose: string; tests: string[]; files: FileRevision[]; diff: string }[] }
export const productRoots: string[]
export function productOwned(path: string): boolean
export function verifyPinnedBaseline(root: string, tag: string, commit: string): void
export function inventory(root: string, baseline: string): FileRevision[]
export function completeDiff(root: string, baseline: string, paths: string[]): string
export function importSpecifiers(path: string, source: string): string[]
export function assertPublicImport(specifier: string, manifest: { exports?: string | Record<string, unknown> }): void
export function verifyDependencies(root: string): void
export function verifyPatches(root: string, baseline: string, manifest: PatchManifest): void
