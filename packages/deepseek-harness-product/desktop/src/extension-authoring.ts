/** Credential-owning personal extension creation, preview and immutable upload. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { c as createTar } from 'tar'
import { ExtensionDraftSchema, ExtensionImportDraftSchema, extensionFiles, parseSkillMarkdown, type ExtensionDraft,
  type ExtensionImportPreview, type ExtensionSaveResult } from '@deepseek-harness/product/authoring'
import { DeepSeekHarnessApiError, type DeepSeekHarnessApiClient } from '@deepseek-harness/product'
import type { ProductSession } from '@deepseek-harness/product/protocol'
import { ARCHIVE_LIMITS, readExtensionDirectory, readExtensionMarkdown, readExtensionTar, readExtensionZip } from './extension-archives.ts'
import { ProductError } from '@deepseek-harness/product/errors'
import { ExtensionContentDraftSchema } from '@deepseek-harness/product/extension-draft'
import { AuthoringSessions, assertAuthoringRevision } from './authoring-sessions.ts'
import { waitForNativeDialog } from './native-dialog.ts'

interface Stage {
  readonly owner: string
  readonly files: Map<string, Buffer>
  readonly expiresAt: number
  readonly saved?: { readonly draft: string; readonly result: ExtensionSaveResult }
}
interface AuthoringOptions {
  readonly directory: string
  readonly selectImport: (source: 'directory' | 'zip' | 'file', kind: 'skill' | 'expert-kit') => Promise<string | undefined>
  readonly installSkill: (id: string, signal: AbortSignal) => Promise<void>
  readonly saveConnector: (draft: ExtensionDraft, api: DeepSeekHarnessApiClient, employee: string, signal: AbortSignal) => Promise<void>
  readonly manageConnector?: (method: string, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    employee: string, signal: AbortSignal) => Promise<unknown>
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid extension metadata')
  return value as Record<string, unknown>
}
const nextVersion = (version: string): string => {
  const [major, minor, patch] = version.split('-')[0]?.split('.') ?? []
  if (major === undefined || minor === undefined || patch === undefined) throw new Error('Invalid resource version')
  return `${major}.${minor}.${String(BigInt(patch) + 1n)}`
}
const isDefiniteRejection = (error: unknown): error is DeepSeekHarnessApiError =>
  error instanceof DeepSeekHarnessApiError && !error.retryable && [400, 401, 403, 404, 409, 413, 415, 422].includes(error.status)

/** Main-process staging is employee scoped; no selected path crosses IPC. */
export class ExtensionAuthoring {
  private readonly stages = new Map<string, Stage>()
  private readonly conversations: AuthoringSessions
  constructor(private readonly options: AuthoringOptions) { this.conversations = new AuthoringSessions(options.directory) }

  /** Release imported bytes when the desktop extension closes. */
  async close(): Promise<void> { await this.conversations.close(); this.stages.clear() }

  /** Dispatch an authenticated authoring request.
   * @param method Allowlisted authoring method.
   * @param input Untrusted renderer payload.
   * @param api Main-owned authenticated transport.
   * @param session UI-safe authenticated identity.
   * @param signal Cancellation propagated from IPC.
   * @returns Preview or business result, without credentials or local paths.
   */
  async invoke(method: string, input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal: AbortSignal): Promise<unknown> {
    const employee = session.employeeId
    if (!session.authenticated || !employee) throw new Error('Authenticated employee is required')
    if (method.startsWith('extensions.connector.')) {
      if (!this.options.manageConnector) throw new Error('Personal connector management is unavailable')
      return this.options.manageConnector(method, input, api, employee, signal)
    }
    if (method.startsWith('extensions.authoring.')) {
      if (typeof input.sessionId !== 'string' || input.sessionId.length === 0 || input.sessionId.length > 256) throw new Error('Invalid creation Session identity')
      const sessionId = input.sessionId
      return this.conversations.using(employee, sessionId, async () => {
        signal.throwIfAborted()
        const state = await this.conversations.read(employee, sessionId, signal)
        if (method === 'extensions.authoring.read') {
          if (input.authoringId !== undefined && state?.authoringId !== input.authoringId) throw new ProductError('EXTENSION_OWNER_REQUIRED', 'Creation conversation is unavailable to this employee', false)
          return state
        }
        if (method === 'extensions.authoring.begin') {
          if (input.kind !== 'skill' && input.kind !== 'expert-kit') throw new Error('Select skill or expert kit')
          const imported = typeof input.stageId === 'string' ? this.stages.get(input.stageId) : undefined
          if (input.stageId !== undefined && (!imported || imported.owner !== employee || imported.expiresAt < Date.now())) throw new Error('Import preview expired; select the package again')
          const files = imported?.files ?? new Map<string, Buffer>()
          const initial = imported ? this.inspect(input.kind, files) : {}
          if (imported && input.edit === true && initial.version) {
            initial.version = nextVersion(initial.version)
          }
          const content = Object.fromEntries(Object.entries(initial)
            .filter(([key]) => Object.hasOwn(ExtensionContentDraftSchema.shape, key)))
          const draft = ExtensionContentDraftSchema.parse({ ...content, kind: input.kind,
            id: initial.id ?? `${input.kind === 'skill' ? 'skill' : 'kit'}-${randomUUID().slice(0, 8)}`,
            version: initial.version ?? '1.0.0', category: initial.category ?? 'other' })
          return this.conversations.begin(employee, sessionId, draft, files, signal, input.edit === true)
        }
        assertAuthoringRevision(state, input)
        if (method === 'extensions.authoring.discard') { await this.conversations.discard(employee, state); return { discarded: true } }
        if (state.saved) {
          if (method === 'extensions.authoring.save') {
            const kind = state.draft.kind
            if (kind !== 'skill' && kind !== 'expert-kit') throw new Error('Invalid saved content kind')
            return this.installSaved({ kind, ...state.saved, visibility: 'PERSONAL', installed: false }, signal)
          }
          throw new ProductError('EXTENSION_VERSION_CONFLICT', 'This version has already been saved; start a new modification conversation', false)
        }
        if (method === 'extensions.authoring.update') {
          if (state.pendingSave) throw new ProductError('EXTENSION_SAVE_PENDING', 'Retry the fixed save before changing this content', true)
          let draft = ExtensionContentDraftSchema.parse(input.draft)
          if (draft.kind !== state.draft.kind || state.editing && (draft.id !== state.draft.id || draft.version !== state.draft.version)) throw new Error('Creation resource identity and version are fixed')
          if (draft.kind === 'expert-kit') {
            const skills = []
            for (const skill of draft.skills ?? []) {
              skills.push(skill.source ? (await this.catalogSkill(api, skill, signal)).skill : skill)
            }
            draft = ExtensionContentDraftSchema.parse({ ...draft, skills })
          }
          return this.conversations.write(employee, { ...state, draft, revision: state.revision + 1 }, signal)
        }
        if (method !== 'extensions.authoring.save') throw new Error('Unsupported creation operation')
        const files = await this.conversations.files(employee, sessionId, signal)
        const stageId = randomUUID()
        if (files.size > 0) this.stages.set(stageId, { owner: employee, files, expiresAt: Date.now() + 60 * 60_000 })
        try {
          const complete = ExtensionDraftSchema.parse(state.draft)
          const intent = state.pendingSave ?? { author: (session.displayName ?? employee).slice(0, 80) }
          const content = { ...complete, author: intent.author, ...files.size > 0 ? { stageId } : {} }
          const result = await this.saveContent(content, api, session, signal, {
            prepare: async (operation) => {
              if (!state.pendingSave) await this.conversations.write(employee, { ...state, pendingSave: intent }, signal)
              try { return await operation() }
              catch (error) {
                if (!state.pendingSave && isDefiniteRejection(error)) {
                  await this.conversations.write(employee, state, new AbortController().signal)
                }
                throw error
              }
            },
            rejectVersion: async (error) => {
              // A previous attempt may have activated before losing its receipt.
              if (state.pendingSave) throw new ProductError('EXTENSION_SAVE_PENDING',
                'The previous save is unconfirmed; retry the unchanged version before editing', true,
                error.resources, { cause: error })
              await this.conversations.write(employee, { ...state, pendingSave: undefined, revision: state.revision + 1,
                draft: { ...state.draft, version: nextVersion(complete.version) } }, new AbortController().signal)
              throw error
            },
          })
          // Server success is durable even if cancellation or device installation follows.
          await this.conversations.write(employee, { ...state, pendingSave: undefined, revision: state.revision + 1,
            saved: { id: complete.id, version: complete.version } }, new AbortController().signal)
          return await this.installSaved(result, signal)
        } finally { this.stages.delete(stageId) }
      })
    }
    for (const [id, stage] of this.stages) if (stage.owner !== employee || stage.expiresAt < Date.now()) this.stages.delete(id)
    if (method === 'extensions.import.release') {
      if (typeof input.stageId !== 'string') throw new Error('Import staging identity is required')
      const stage = this.stages.get(input.stageId)
      if (stage?.owner === employee) this.stages.delete(input.stageId)
      return { released: true }
    }
    if (method === 'extensions.import.inspect') {
      if (input.kind !== 'skill' && input.kind !== 'expert-kit') throw new Error('Select skill or expert kit')
      if (this.stages.size >= 4) throw new Error('Close another import before importing more packages')
      let files: Map<string, Buffer>
      if (input.source === 'catalog') {
        if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(input.id)) throw new Error('Invalid resource identity')
        const prefix = `/api/v1/${input.kind === 'skill' ? 'skills' : 'expert-kits'}/${encodeURIComponent(input.id)}`
        const metadata = record(await api.request(prefix, { signal }))
        if (metadata.canEdit !== true || metadata.ownerEmployeeId !== employee) throw new ProductError('EXTENSION_OWNER_REQUIRED', 'Only the owner may edit', false)
        files = await this.download(api, prefix, metadata, signal)
      } else {
        if (input.source !== 'directory' && input.source !== 'zip' && input.source !== 'file') throw new Error('Select a directory or package file')
        const source = input.source
        const kind = input.kind
        const path = await waitForNativeDialog(() => this.options.selectImport(source, kind), signal)
        signal.throwIfAborted()
        if (!path) return { cancelled: true }
        try {
          files = input.source === 'directory' ? await readExtensionDirectory(path, signal)
            : input.source === 'file' && input.kind === 'skill' && extname(path).toLowerCase() === '.md'
              ? await readExtensionMarkdown(path, signal) : await readExtensionZip(path, signal)
        }
        catch (_error) { signal.throwIfAborted(); throw new ProductError('EXTENSION_IMPORT_INVALID', 'Import contains missing, invalid or oversized package files', false) }
      }
      files = this.packageRoot(files)
      const draft = this.inspect(input.kind, files)
      signal.throwIfAborted()
      const stageId = randomUUID()
      this.stages.set(stageId, { owner: employee, files, expiresAt: Date.now() + 60 * 60_000 })
      const checked = ExtensionDraftSchema.safeParse({ ...draft, stageId })
      return { stageId, draft: { ...draft, stageId }, files: [...files].map(([path, value]) => ({ path, bytes: value.length })),
        missingFields: checked.success ? [] : [...new Set(checked.error.issues.map(issue => issue.path.join('.')))] } satisfies ExtensionImportPreview
    }
    if (method === 'extensions.bundledSkill.read') {
      if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(input.id)
        || typeof input.skillId !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(input.skillId)) throw new Error('Invalid bundled skill identity')
      const prefix = `/api/v1/expert-kits/${encodeURIComponent(input.id)}`
      const metadata = record(await api.request(prefix, { signal }))
      const files = await this.download(api, prefix, metadata, signal)
      const draft = this.inspect('expert-kit', files)
      const skill = draft.skills?.find(value => value.id === input.skillId)
      const readme = files.get(`skills/${input.skillId}/SKILL.md`)
      if (!skill || !readme) throw new ProductError('EXTENSION_IMPORT_INVALID', 'Bundled skill is missing', false)
      return { ...skill, readme: readme.toString('utf8') }
    }
    if (method === 'extensions.submit' || method === 'extensions.delete') {
      const kind = input.kind
      if (!['skill', 'expert-kit', 'connector'].includes(String(kind)) || typeof input.id !== 'string'
        || !/^[a-z][a-z0-9-]{2,63}$/.test(input.id) || typeof input.version !== 'string'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)) throw new Error('Invalid extension coordinate')
      if (method === 'extensions.delete') {
        if (kind === 'connector') throw new Error('Use personal connector management to delete a connector')
        await api.request(`/api/v1/extension-submissions/${String(kind)}/${encodeURIComponent(input.id)}?version=${encodeURIComponent(input.version)}`,
          { method: 'DELETE', signal })
        return { removed: true, id: input.id }
      }
      await api.request(`/api/v1/extension-submissions/${String(kind)}/${encodeURIComponent(input.id)}/versions/${encodeURIComponent(input.version)}/submissions`,
        { method: 'POST', signal })
      return { submitted: true, id: input.id, version: input.version }
    }
    if (method !== 'extensions.save') throw new Error('Unsupported authoring operation')
    const stage = typeof input.stageId === 'string' ? this.stages.get(input.stageId) : undefined
    const encoded = JSON.stringify(ExtensionDraftSchema.parse(input))
    if (stage?.saved && stage.saved.draft !== encoded) throw new ProductError('EXTENSION_VERSION_CONFLICT', 'The imported version is saved; start a new modification conversation', false)
    const result = stage?.saved?.result ?? await this.saveContent(input, api, session, signal)
    if (stage && typeof input.stageId === 'string') this.stages.set(input.stageId, { ...stage, saved: { draft: encoded, result } })
    const installed = await this.installSaved(result, signal)
    if (typeof input.stageId === 'string') this.stages.delete(input.stageId)
    return installed
  }

  private async installSaved(result: ExtensionSaveResult, signal: AbortSignal): Promise<ExtensionSaveResult> {
    signal.throwIfAborted()
    if (result.kind !== 'skill') return result
    try { await this.options.installSkill(result.id, signal) }
    catch (error) {
      signal.throwIfAborted()
      throw new ProductError('EXTENSION_INSTALL_FAILED', 'The skill is saved; retry device installation without saving a new version', true,
        [{ kind: 'skill', id: result.id }], { cause: error })
    }
    return { ...result, installed: true }
  }

  private async saveContent(input: Readonly<Record<string, unknown>>, api: DeepSeekHarnessApiClient,
    session: ProductSession, signal: AbortSignal,
    saving?: {
      readonly prepare: (operation: () => Promise<unknown>) => Promise<unknown>
      readonly rejectVersion: (error: ProductError) => Promise<never>
    }): Promise<ExtensionSaveResult> {
    const employee = session.employeeId
    if (!session.authenticated || !employee) throw new Error('Authenticated employee is required')
    let draft = ExtensionDraftSchema.parse(input)
    if (!draft.author?.trim()) draft = { ...draft, author: (session.displayName ?? employee).slice(0, 80) }
    if (draft.kind === 'connector') {
      await this.options.saveConnector(draft, api, employee, signal)
      return { kind: draft.kind, id: draft.id, version: draft.version, visibility: 'PERSONAL', installed: false } satisfies ExtensionSaveResult
    }
    const original = draft.stageId ? this.stages.get(draft.stageId) : undefined
    if (draft.stageId && (!original || original.owner !== employee)) throw new Error('Import preview expired; select the package again')
    const resources = new Map(original?.files ?? [])
    if (draft.kind === 'expert-kit' && original) {
      const imported = this.inspect('expert-kit', original.files)
      const importedIds = new Set((imported.skills ?? []).map(skill => skill.id))
      for (const path of resources.keys()) if (path.startsWith('skills/')) resources.delete(path)
      for (const skill of draft.skills) {
        if (!skill.importedId) continue
        if (!importedIds.has(skill.importedId)) throw new ProductError('EXTENSION_IMPORT_INVALID', 'Imported skill identity is invalid', false)
        const prefix = `skills/${skill.importedId}/`
        for (const [path, bytes] of original.files) {
          if (path.startsWith(prefix)) resources.set(`skills/${skill.id}/${path.slice(prefix.length)}`, bytes)
        }
      }
    } else if (draft.skills.some(skill => skill.importedId !== undefined)) {
      throw new ProductError('EXTENSION_IMPORT_INVALID', 'Imported skill has no package staging', false)
    }
    const skills = []
    for (const skill of draft.skills) {
      signal.throwIfAborted()
      if (!skill.source) { skills.push(skill); continue }
      const { skill: fixed, files: content } = await this.catalogSkill(api, skill, signal)
      skills.push(fixed)
      for (const [path, data] of content) {
        if (!path.startsWith('.deepseek-harness-skill/')) resources.set(`skills/${fixed.id}/${path}`, data)
      }
    }
    draft = ExtensionDraftSchema.parse({ ...draft, skills })
    const generated = extensionFiles(draft, Object.fromEntries([...generatedFilesOnly(resources)]
      .filter(([path]) => path.endsWith('SKILL.md')).map(([path, bytes]) => [path, bytes.toString('utf8')])))
    for (const path of generatedFilesOnly(resources).keys()) resources.delete(path)
    for (const [path, value] of Object.entries(generated.files)) resources.set(path, Buffer.from(value))
    const work = await mkdtemp(join(tmpdir(), 'harness-extension-'))
    try {
      const root = join(work, 'content')
      await mkdir(root)
      let size = 0
      if (resources.size > ARCHIVE_LIMITS.files) throw new Error('Extension has too many files')
      for (const [path, value] of resources) {
        signal.throwIfAborted()
        size += value.length
        if (size > ARCHIVE_LIMITS.extractedBytes) throw new Error('Extension exceeds extracted size limit')
        const filename = join(root, path)
        await mkdir(join(filename, '..'), { recursive: true })
        await writeFile(filename, value, { mode: 0o600, signal })
      }
      const archive = join(work, 'content.tar.gz')
      await createTar({ cwd: root, file: archive, gzip: true, portable: true, noMtime: true }, [...resources.keys()].sort())
      const bytes = await readFile(archive, { signal })
      if (bytes.length > ARCHIVE_LIMITS.compressedBytes) throw new Error('Extension exceeds upload size limit')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const request = () => api.request('/api/v1/extension-submissions/releases', { method: 'POST', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...generated.release, sha256 }) })
      const prepared = record(await (saving ? saving.prepare(request) : request()))
      const assessment = record(prepared.assessment)
      if (assessment.status === 'BLOCKED') {
        const issues = Array.isArray(assessment.issues) ? assessment.issues.map((value: unknown) => {
          const issue = record(value)
          if (typeof issue.code !== 'string' || typeof issue.message !== 'string') throw new Error('Invalid dependency issue')
          return `${issue.code}: ${issue.message}`
        }) : []
        const error = new ProductError('EXTENSION_DEPENDENCY_BLOCKED',
          `Extension dependencies did not pass server validation${issues.length ? ': ' + issues.join('; ') : ''}`,
          false, [{ kind: draft.kind, id: draft.id }])
        if (saving) return await saving.rejectVersion(error)
        throw error
      }
      if (prepared.uploadUrl !== null) {
        if (typeof prepared.uploadUrl !== 'string') throw new Error('Upload URL is missing')
        const upload = await fetch(prepared.uploadUrl, { method: 'PUT', signal, redirect: 'error', headers: { 'content-type': 'application/gzip' }, body: bytes })
        if (!upload.ok) throw new Error('Extension upload failed')
      }
      try {
        await api.request(`/api/v1/extension-submissions/${draft.kind}/${encodeURIComponent(draft.id)}/versions/${encodeURIComponent(draft.version)}/activations`, { method: 'POST', signal })
      } catch (error) {
        if (saving && isDefiniteRejection(error)) return await saving.rejectVersion(error)
        throw error
      }
      return { kind: draft.kind, id: draft.id, version: draft.version, visibility: 'PERSONAL', installed: false } satisfies ExtensionSaveResult
    } finally { await rm(work, { recursive: true, force: true }) }
  }

  private packageRoot(files: Map<string, Buffer>): Map<string, Buffer> {
    if (files.has('SKILL.md') || files.has('README.md')) return files
    const roots = new Set([...files.keys()].map(path => path.split('/')[0]))
    if (roots.size !== 1) throw new Error('Select a standard skill or kit package root')
    return new Map([...files].map(([path, bytes]) => [path.slice(path.indexOf('/') + 1), bytes]))
  }

  private async catalogSkill(api: DeepSeekHarnessApiClient, skill: ExtensionDraft['skills'][number],
    signal: AbortSignal): Promise<{ skill: ExtensionDraft['skills'][number]; files: Map<string, Buffer> }> {
    const source = skill.source
    if (!source) throw new Error('Catalog skill coordinate is required')
    const prefix = `/api/v1/skills/${encodeURIComponent(source.id)}/versions/${encodeURIComponent(source.version)}`
    const files = await this.download(api, prefix, source, signal)
    const fixed = ExtensionDraftSchema.parse(this.inspect('skill', files))
    if (fixed.id !== source.id || fixed.version !== source.version) {
      throw new ProductError('EXTENSION_VERSION_CONFLICT', 'Skill metadata differs from the selected content', false)
    }
    return { skill: { id: fixed.id, name: fixed.name, summary: fixed.summary, body: fixed.body, triggers: fixed.triggers,
      connectorRefs: fixed.connectorRefs, requiredTools: fixed.requiredTools, knowledgeBaseRefs: fixed.knowledgeBaseRefs, source }, files }
  }

  private async download(api: DeepSeekHarnessApiClient, prefix: string, metadata: Record<string, unknown>,
    signal: AbortSignal): Promise<Map<string, Buffer>> {
    const artifact = record(await api.request(`${prefix}/artifacts`, { signal }))
    if (artifact.version !== metadata.version || artifact.sha256 !== metadata.sha256) {
      throw new ProductError('EXTENSION_VERSION_CONFLICT', 'Artifact version differs from the selected content', false)
    }
    const url = artifact.downloadUrl ?? artifact.url
    if (typeof url !== 'string' || typeof metadata.sha256 !== 'string') throw new Error('Invalid artifact download')
    const response = await fetch(url, { signal, redirect: 'error' })
    if (!response.ok || !response.body) throw new Error('Artifact download failed')
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > ARCHIVE_LIMITS.compressedBytes) throw new ProductError('EXTENSION_IMPORT_INVALID', 'Package exceeds size limit', false)
      chunks.push(Buffer.from(chunk))
    }
    const bytes = Buffer.concat(chunks)
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new ProductError('EXTENSION_IMPORT_INVALID', 'Artifact checksum mismatch', false)
    return readExtensionTar(bytes, signal)
  }

  private inspect(kind: 'skill' | 'expert-kit', files: Map<string, Buffer>): ExtensionImportPreview['draft'] {
    const manifestPath = kind === 'skill' ? '.deepseek-harness-skill/skill.json' : '.deepseek-harness-kit/kit.json'
    const metadata = files.get(manifestPath)
    const manifest = metadata ? record(JSON.parse(metadata.toString('utf8'))) : {}
    if (kind === 'expert-kit' && (!metadata || manifest.schemaVersion !== '3')) throw new Error('A standard expert kit manifest (schema 3) is required')
    if (metadata && kind === 'skill' && manifest.schemaVersion !== '1') throw new Error('Unsupported skill metadata')
    const markdown = files.get(kind === 'skill' ? 'SKILL.md' : 'README.md')
    if (!markdown) throw new Error(kind === 'skill' ? 'Missing SKILL.md' : 'Missing README.md')
    const parsed = kind === 'skill' ? parseSkillMarkdown(markdown.toString('utf8')) : undefined
    const bundled = kind === 'expert-kit' && Array.isArray(manifest.skills) ? manifest.skills.map((value) => {
      const item = record(value)
      if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(item.id)
        || item.path !== `skills/${item.id}/SKILL.md`) throw new Error('Invalid bundled skill path')
      const source = files.get(item.path)
      if (!source) throw new Error('Missing bundled SKILL.md')
      const fields = parseSkillMarkdown(source.toString('utf8'), true)
      if (fields.id !== item.id) throw new Error('Bundled skill identity differs from manifest')
      return { id: fields.id, importedId: fields.id, name: typeof item.name === 'string' ? item.name : fields.id,
        summary: fields.summary, description: fields.description, body: fields.body, triggers: item.triggers ?? [],
        connectorRefs: item.connectorRefs ?? [],
        requiredTools: item.requiredTools ?? [], knowledgeBaseRefs: item.knowledgeBaseRefs ?? [] }
    }) : []
    const { schemaVersion: _schema, allowImplicitInvocation: _implicit, skills: _skills, ...editable } = manifest
    return ExtensionImportDraftSchema.parse({ ...editable, kind, id: parsed?.id ?? manifest.id,
      summary: parsed?.summary ?? manifest.summary,
      body: parsed?.body ?? markdown.toString('utf8'), skills: bundled })
  }
}

function generatedFilesOnly(resources: Map<string, Buffer>): Map<string, Buffer> {
  return new Map([...resources].filter(([path]) => path === 'SKILL.md' || path === 'README.md'
    || path === '.deepseek-harness-skill/skill.json' || path === '.deepseek-harness-kit/kit.json'
    || /^skills\/[^/]+\/SKILL.md$/.test(path)))
}
