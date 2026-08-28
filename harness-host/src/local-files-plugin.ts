import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'xiaoyin-local-files'
export const inject = ['tools']

const MAX_ROOTS = 8
const MAX_ENTRIES = 200
const MAX_DEPTH = 3
const MAX_TEXT_BYTES = 256 * 1024
const MAX_WRITE_BYTES = 2 * 1024 * 1024
const MUTATING_TOOLS = new Set([
  'local_files_write_text', 'local_files_create_directory', 'local_files_copy',
  'local_files_move', 'local_files_delete',
])
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.sql', '.log',
])
const BLOCKED_FILE_NAMES = new Set([
  '.env', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519',
])

export interface Config {
  roots?: string[]
  enabled?: boolean
}

export const Config = z.object({
  roots: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
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
  if (config.enabled === false) return
  const roots = await discoverAuthorizedRoots(config.roots ?? [])
  if (roots.length === 0) return

  const bridge = new LocalFileBridge(roots)
  const unregister = [
    ctx.tools.register(rootsTool(bridge)),
    ctx.tools.register(listTool(bridge)),
    ctx.tools.register(readTextTool(bridge)),
    ctx.tools.register(writeTextTool(bridge)),
    ctx.tools.register(createDirectoryTool(bridge)),
    ctx.tools.register(copyTool(bridge)),
    ctx.tools.register(moveTool(bridge)),
    ctx.tools.register(deleteTool(bridge)),
  ]
  const stopApprovalPolicy = ctx.on('tools/pre-execute', (exec, next) => {
    if (!MUTATING_TOOLS.has(exec.name)) return next()
    return Promise.resolve({
      kind: 'ask' as const,
      reason: mutationApprovalReason(exec.name, exec.arguments),
    })
  })
  ctx.effect(() => () => {
    stopApprovalPolicy()
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

  async writeText(rootId: string, requestedPath: string, content: string, overwrite: boolean): Promise<object> {
    const root = this.root(rootId)
    this.ensureWritableFileName(requestedPath)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_WRITE_BYTES) throw new Error(`Text content exceeds the ${MAX_WRITE_BYTES} byte limit`)
    const target = await this.resolveTargetInsideRoot(root, requestedPath)
    await writeFile(target, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' })
    return { rootId: root.id, rootName: root.name, path: this.displayPath(root, target), size: bytes }
  }

  async createDirectory(rootId: string, requestedPath: string): Promise<object> {
    const root = this.root(rootId)
    this.ensureWritableFileName(requestedPath, false)
    const target = await this.resolveTargetInsideRoot(root, requestedPath, true)
    await mkdir(target, { recursive: true })
    const canonical = await realpath(target)
    if (!isInside(root.path, canonical)) throw new Error('Created directory escapes the authorized directory')
    return { rootId: root.id, rootName: root.name, path: this.displayPath(root, canonical) }
  }

  async copy(rootId: string, sourcePath: string, destinationPath: string, overwrite: boolean): Promise<object> {
    const root = this.root(rootId)
    this.ensureWritableFileName(sourcePath, false)
    const source = await this.resolveInsideRoot(root, sourcePath)
    if (!(await stat(source)).isFile()) throw new Error('Only individual files can be copied')
    this.ensureWritableFileName(destinationPath, false)
    const destination = await this.resolveTargetInsideRoot(root, destinationPath)
    await copyFile(source, destination, overwrite ? 0 : fsConstants.COPYFILE_EXCL)
    return { rootId: root.id, rootName: root.name, source: this.displayPath(root, source), destination: this.displayPath(root, destination) }
  }

  async move(rootId: string, sourcePath: string, destinationPath: string): Promise<object> {
    const root = this.root(rootId)
    this.ensureWritableFileName(sourcePath, false)
    const source = await this.resolveInsideRoot(root, sourcePath)
    if (source === root.path) throw new Error('The authorized root directory cannot be moved')
    this.ensureWritableFileName(destinationPath, false)
    const destination = await this.resolveTargetInsideRoot(root, destinationPath)
    try {
      await stat(destination)
      throw new Error('Move destination already exists')
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await rename(source, destination)
    return { rootId: root.id, rootName: root.name, source: sourcePath, destination: this.displayPath(root, destination) }
  }

  async delete(rootId: string, requestedPath: string, recursive: boolean): Promise<object> {
    const root = this.root(rootId)
    this.ensureWritableFileName(requestedPath, false)
    const target = await this.resolveInsideRoot(root, requestedPath)
    if (target === root.path) throw new Error('The authorized root directory cannot be deleted')
    const metadata = await stat(target)
    if (metadata.isDirectory() && !recursive) throw new Error('recursive must be true to delete a directory')
    await rm(target, { recursive, force: false })
    return { rootId: root.id, rootName: root.name, path: this.displayPath(root, target), deleted: true }
  }

  async resolveExisting(rootId: string, requestedPath: string): Promise<{ root: AuthorizedRoot; target: string }> {
    const root = this.root(rootId)
    return { root, target: await this.resolveInsideRoot(root, requestedPath) }
  }

  async resolveTarget(rootId: string, requestedPath: string): Promise<{ root: AuthorizedRoot; target: string }> {
    const root = this.root(rootId)
    return { root, target: await this.resolveTargetInsideRoot(root, requestedPath) }
  }

  visiblePath(root: AuthorizedRoot, target: string): string {
    return this.displayPath(root, target)
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

  private async resolveTargetInsideRoot(
    root: AuthorizedRoot,
    requestedPath: string,
    allowMissingParents = false,
  ): Promise<string> {
    if (!requestedPath || requestedPath.includes('\0') || isAbsolute(requestedPath)) {
      throw new Error('Local file paths must be non-empty and relative to an authorized directory')
    }
    const candidate = resolve(root.path, requestedPath)
    if (!isInside(root.path, candidate) || candidate === root.path) {
      throw new Error('Local file path escapes the authorized directory')
    }
    let ancestor = candidate
    while (true) {
      try {
        const canonical = await realpath(ancestor)
        if (!isInside(root.path, canonical)) throw new Error('Local file symlink escapes the authorized directory')
        if (!allowMissingParents && ancestor === candidate) {
          const metadata = await stat(canonical)
          if (metadata.isDirectory()) throw new Error('Target path is a directory')
        }
        return candidate
      } catch (error) {
        if (isNotFound(error)) {
          const parent = resolve(ancestor, '..')
          if (parent === ancestor || !isInside(root.path, parent)) throw new Error('Local file path escapes the authorized directory')
          if (!allowMissingParents && ancestor !== candidate) throw new Error('Target parent directory does not exist')
          ancestor = parent
          continue
        }
        throw error
      }
    }
  }

  private ensureWritableFileName(requestedPath: string, requireTextExtension = true): void {
    const name = basename(requestedPath).toLowerCase()
    if (isBlockedFileName(name)) throw new Error('Credential and environment files cannot be written by the Agent')
    if (requireTextExtension && !ALLOWED_TEXT_EXTENSIONS.has(extname(name))) {
      throw new Error('Only approved text, source, CSV, JSON and YAML files can be written')
    }
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

function writeTextTool(bridge: LocalFileBridge): ToolDefinition {
  return mutationTool('local_files_write_text', 'Create or replace one UTF-8 text file in an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative destination file path.'),
    content: { type: 'string', maxLength: MAX_WRITE_BYTES }, overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'path', 'content'], async (input) => bridge.writeText(
    requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'),
    requiredContent(input.content), optionalBoolean(input.overwrite, false, 'overwrite'),
  ))
}

function createDirectoryTool(bridge: LocalFileBridge): ToolDefinition {
  return mutationTool('local_files_create_directory', 'Create a directory, including missing parents, below an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative directory path.'),
  }, ['rootId', 'path'], async (input) => bridge.createDirectory(requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path')))
}

function copyTool(bridge: LocalFileBridge): ToolDefinition {
  return mutationTool('local_files_copy', 'Copy one file within an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), sourcePath: stringProperty('Relative source file path.'),
    destinationPath: stringProperty('Relative destination file path.'), overwrite: { type: 'boolean', default: false },
  }, ['rootId', 'sourcePath', 'destinationPath'], async (input) => bridge.copy(
    requiredString(input.rootId, 'rootId'), requiredString(input.sourcePath, 'sourcePath'),
    requiredString(input.destinationPath, 'destinationPath'), optionalBoolean(input.overwrite, false, 'overwrite'),
  ))
}

function moveTool(bridge: LocalFileBridge): ToolDefinition {
  return mutationTool('local_files_move', 'Move or rename one file or directory within an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), sourcePath: stringProperty('Relative source path.'),
    destinationPath: stringProperty('Relative destination path.'),
  }, ['rootId', 'sourcePath', 'destinationPath'], async (input) => bridge.move(
    requiredString(input.rootId, 'rootId'), requiredString(input.sourcePath, 'sourcePath'), requiredString(input.destinationPath, 'destinationPath'),
  ))
}

function deleteTool(bridge: LocalFileBridge): ToolDefinition {
  return mutationTool('local_files_delete', 'Permanently delete one file or directory below an authorized directory.', {
    rootId: stringProperty('Authorized root ID.'), path: stringProperty('Relative path.'), recursive: { type: 'boolean', default: false },
  }, ['rootId', 'path'], async (input) => bridge.delete(
    requiredString(input.rootId, 'rootId'), requiredString(input.path, 'path'), optionalBoolean(input.recursive, false, 'recursive'),
  ))
}

function mutationTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  execute: (input: Record<string, unknown>) => Promise<unknown>,
): ToolDefinition {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: renderValue(value) }] },
    async execute(args) { return execute(asRecord(args)) },
    isConcurrencySafe: () => false,
  }
}

function stringProperty(description: string): object {
  return { type: 'string', description, minLength: 1, maxLength: 4096 }
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

function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
}

function requiredContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('content must be a string')
  return value
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function mutationApprovalReason(toolName: string, args: unknown): string {
  const input = asRecord(args)
  const paths = ['path', 'sourcePath', 'destinationPath']
    .flatMap((key) => typeof input[key] === 'string' ? [`${key}: ${input[key]}`] : [])
  const action = toolName === 'local_files_delete' ? '永久删除本地内容' : '修改本地文件'
  return `${action}\n${paths.join('\n') || '目标路径由工具参数指定'}\n工具：${toolName}`
}

function renderValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
