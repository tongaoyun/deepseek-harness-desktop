import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'xiaoyin-local-files'
export const inject = ['tools']

const MAX_ROOTS = 8
const MAX_ENTRIES = 200
const MAX_DEPTH = 3
const MAX_TEXT_BYTES = 256 * 1024
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.sql', '.log',
])
const BLOCKED_FILE_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519',
])

export interface Config {
  roots?: string[]
}

export const Config = z.object({
  roots: z.array(z.string()).default([]),
})

export interface AuthorizedRoot {
  id: string
  name: string
  path: string
}

export interface LocalFileEntry {
  path: string
  type: 'directory' | 'file'
  size?: number
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return

  const bridge = new LocalFileBridge(roots)
  const unregister = [
    ctx.tools.register(rootsTool(bridge)),
    ctx.tools.register(listTool(bridge)),
    ctx.tools.register(readTextTool(bridge)),
  ]
  ctx.effect(() => () => {
    for (const dispose of unregister.reverse()) dispose()
  }, 'xiaoyin local file bridge')
}

export async function discoverAuthorizedRoots(paths: string[]): Promise<AuthorizedRoot[]> {
  if (paths.length > MAX_ROOTS) throw new Error(`At most ${MAX_ROOTS} local directories may be authorized`)
  const canonicalPaths: string[] = []
  for (const value of paths) {
    if (!isAbsolute(value)) throw new Error('Authorized local directories must use absolute paths')
    const canonical = await realpath(value)
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error(`Authorized local path is not a directory: ${value}`)
    }
    if (!canonicalPaths.includes(canonical)) canonicalPaths.push(canonical)
  }
  return canonicalPaths.map((path, index) => ({
    id: `local-root-${index + 1}`,
    name: basename(path) || '已授权目录',
    path,
  }))
}

export class LocalFileBridge {
  constructor(private readonly roots: AuthorizedRoot[]) {}

  visibleRoots(): Array<{ id: string; name: string }> {
    return this.roots.map(({ id, name }) => ({ id, name }))
  }

  async list(rootId: string, requestedPath = '', depth = 1): Promise<{
    rootId: string
    rootName: string
    directory: string
    entries: LocalFileEntry[]
    truncated: boolean
  }> {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
      throw new Error(`depth must be an integer between 1 and ${MAX_DEPTH}`)
    }
    const root = this.root(rootId)
    const directory = await this.resolveInsideRoot(root, requestedPath)
    if (!(await stat(directory)).isDirectory()) throw new Error('Requested local path is not a directory')

    const entries: LocalFileEntry[] = []
    await this.walk(root, directory, depth, entries)
    return {
      rootId: root.id,
      rootName: root.name,
      directory: this.displayPath(root, directory),
      entries,
      truncated: entries.length >= MAX_ENTRIES,
    }
  }

  async readText(rootId: string, requestedPath: string): Promise<{
    rootId: string
    rootName: string
    path: string
    size: number
    content: string
  }> {
    const root = this.root(rootId)
    const file = await this.resolveInsideRoot(root, requestedPath)
    const fileName = basename(file).toLowerCase()
    if (BLOCKED_FILE_NAMES.has(fileName) || fileName.startsWith('.env.')) {
      throw new Error('Credential and environment files cannot be read by the Agent')
    }
    if (!ALLOWED_TEXT_EXTENSIONS.has(extname(fileName))) {
      throw new Error('Only approved text, source, CSV, JSON and YAML files can be read')
    }
    const metadata = await stat(file)
    if (!metadata.isFile()) throw new Error('Requested local path is not a file')
    if (metadata.size > MAX_TEXT_BYTES) {
      throw new Error(`Local text file exceeds the ${MAX_TEXT_BYTES} byte limit`)
    }
    const bytes = await readFile(file)
    if (bytes.includes(0)) throw new Error('Binary files cannot be read as text')
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('Local text file must use UTF-8 encoding')
    }
    return {
      rootId: root.id,
      rootName: root.name,
      path: this.displayPath(root, file),
      size: metadata.size,
      content,
    }
  }

  private root(rootId: string): AuthorizedRoot {
    const root = this.roots.find((candidate) => candidate.id === rootId)
    if (!root) throw new Error(`Unknown authorized local root: ${rootId}`)
    return root
  }

  private async resolveInsideRoot(root: AuthorizedRoot, requestedPath: string): Promise<string> {
    if (requestedPath.includes('\0') || isAbsolute(requestedPath)) {
      throw new Error('Local file paths must be relative to an authorized directory')
    }
    const candidate = resolve(root.path, requestedPath || '.')
    if (!isInside(root.path, candidate)) throw new Error('Local file path escapes the authorized directory')
    const canonical = await realpath(candidate)
    if (!isInside(root.path, canonical)) throw new Error('Local file symlink escapes the authorized directory')
    return canonical
  }

  private async walk(
    root: AuthorizedRoot,
    directory: string,
    remainingDepth: number,
    entries: LocalFileEntry[],
  ): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) return
      if (child.isSymbolicLink()) continue
      const childPath = resolve(directory, child.name)
      if (child.isDirectory()) {
        entries.push({ path: this.displayPath(root, childPath), type: 'directory' })
        if (remainingDepth > 1) await this.walk(root, childPath, remainingDepth - 1, entries)
      } else if (child.isFile()) {
        if (isBlockedFileName(child.name)) continue
        const metadata = await stat(childPath)
        entries.push({ path: this.displayPath(root, childPath), type: 'file', size: metadata.size })
      }
    }
  }

  private displayPath(root: AuthorizedRoot, target: string): string {
    const value = relative(root.path, target).split(sep).join('/')
    return value || '.'
  }
}

function rootsTool(bridge: LocalFileBridge): ToolDefinition {
  return {
    name: 'local_files_roots',
    description: 'List the local directories that the employee explicitly authorized for this task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: renderValue(value) }] },
    async execute() { return { roots: bridge.visibleRoots() } },
    isConcurrencySafe: () => true,
  }
}

function listTool(bridge: LocalFileBridge): ToolDefinition {
  return {
    name: 'local_files_list',
    description: 'List files below an employee-authorized local directory. Symlink targets are not traversed.',
    parameters: {
      type: 'object',
      properties: {
        rootId: { type: 'string', description: 'Authorized root ID returned by local_files_roots.' },
        path: { type: 'string', description: 'Relative directory path. Use an empty string for the root.' },
        depth: { type: 'integer', minimum: 1, maximum: MAX_DEPTH, default: 1 },
      },
      required: ['rootId'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: renderValue(value) }] },
    async execute(args) {
      const input = asRecord(args)
      return bridge.list(requiredString(input.rootId, 'rootId'), optionalString(input.path, 'path'), optionalDepth(input.depth))
    },
    isConcurrencySafe: () => true,
  }
}

function readTextTool(bridge: LocalFileBridge): ToolDefinition {
  return {
    name: 'local_files_read_text',
    description: 'Read one approved UTF-8 text file below an employee-authorized local directory.',
    parameters: {
      type: 'object',
      properties: {
        rootId: { type: 'string', description: 'Authorized root ID returned by local_files_roots.' },
        path: { type: 'string', description: 'Relative file path returned by local_files_list.' },
      },
      required: ['rootId', 'path'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: renderValue(value) }] },
    async execute(args) {
      const input = asRecord(args)
      return bridge.readText(requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'))
    },
    isConcurrencySafe: () => true,
  }
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

function isBlockedFileName(value: string): boolean {
  const fileName = value.toLowerCase()
  return BLOCKED_FILE_NAMES.has(fileName) || fileName.startsWith('.env.')
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Local file tool arguments must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, name: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > 4096) throw new Error(`${name} must be a string`)
  return value
}

function optionalDepth(value: unknown): number {
  if (value === undefined) return 1
  if (typeof value !== 'number') throw new Error('depth must be a number')
  return value
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
