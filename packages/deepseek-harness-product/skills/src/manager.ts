/** Product skill operations carried by the native Typert Remote service. */
import type {} from '@deepseek-harness/product-runtime/company-content'
import type { SkillManagerResults } from './generated/results.ts'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { realpath } from 'node:fs/promises'
import type { Log, ManagerScope, ManagerTarget, ManagerImport, RootView, Diagnostic, OperationError, SkillRequest, RepositoryInput, CatalogIdentity, ManagerMarketOptions } from './types.ts'
import { state, setSkillEnabled, setSourceEnabled, createCategory, renameCategory, deleteCategory, assignSkillCategory, moveSkillInCategory, setCategoryEnabled, importSkill, importUploadedSkill, browseDirectories, createSkill, skillDetail, exportSkill, userRoots, projectRoots, resolveWorkspaceTarget, listWorkspaces, workspaceSkills } from './core.ts'
import { createRepositoryManager } from './repositories.ts'
import { installationSourceKey } from './repository-updates.ts'
import { listClawHub, searchClawHub } from './clawhub-catalog.ts'
import { searchSkillsSh } from './skills-sh-catalog.ts'
import { loadCatalogPackage, readCatalogSkill } from './catalog-skill.ts'
import { activeSessionCwds, registeredWorkspacePaths } from './host-runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { skillsManager: SkillsManager }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'skills/operation': Diagnostic & { error: string } }
}

type Success<T> = T extends { error: string } ? never : T
interface OperationOptions {
  readonly mutation?: boolean
  readonly notify?: boolean
}

/** Native Remote owner for personal skills, registered projects, imports and repositories. */
export class SkillsManager extends TypertRemoteService {
  static inject = ['sessions', 'typert']
  private readonly repositories
  private readonly log: Log
  private readonly afterWrite: () => void
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, options: { log: Log; afterWrite: () => void }) {
    super(ctx, 'skillsManager')
    ctx.effect(() => async () => { this.lifetime.abort(); await Promise.allSettled([...this.active]) }, 'skills-manager pending operations')
    this.log = options.log
    this.afterWrite = options.afterWrite
    this.repositories = createRepositoryManager({ log: this.log, registeredWorkspaces: () => registeredWorkspacePaths(ctx) })
  }

  private async perform<T>(
    task: (signal: AbortSignal) => T | Promise<T>, signal: AbortSignal, options: OperationOptions = {},
  ): Promise<Success<T>> {
    const { mutation = false, notify = false } = options
    signal = AbortSignal.any([signal, this.lifetime.signal])
    const run = async () => {
      signal.throwIfAborted()
      // Management is the local owner's capability; a model/MCP Peer cannot select another user's files.
      if (this.ctx.invocation && this.ctx.invocation.peer.principal.kind !== 'owner') {
        throw new RemoteError('skills/operation', 'Skill management requires the Host owner', { code: 'error.proto.forbidden', error: 'forbidden' })
      }
      try {
        const value = await task(signal)
        if (value && typeof value === 'object' && 'ok' in value && value.ok === false && 'error' in value && typeof value.error === 'string') {
          const failure: OperationError = { ok: false, error: value.error, ...'code' in value && typeof value.code === 'string' ? { code: value.code } : {}, ...'params' in value && value.params && typeof value.params === 'object' && !Array.isArray(value.params) && isJsonValue(value.params) ? { params: value.params as Record<string, JsonValue> } : {} }
          throw new RemoteError('skills/operation', failure.error, failure)
        }
        if (notify) this.afterWrite()
        // The discriminant above removed the core operation's failure branch.
        return value as Success<T>
      } catch (error) {
        if (signal.aborted) throw new RemoteError('gateway/cancelled', 'Skill operation cancelled', {}, { cause: error })
        if (remoteErrorOf(error)) throw error
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
          const params = 'params' in error && error.params !== null && typeof error.params === 'object' && !Array.isArray(error.params) && isJsonValue(error.params) ? error.params as Record<string, JsonValue> : undefined
          throw new RemoteError('skills/operation', error.message, { error: error.message, code: error.code, ...(params ? { params } : {}) }, { cause: error })
        }
        throw error
      }
    }
    const result = mutation ? this.mutationQueue.then(run, run) : run()
    if (mutation) this.mutationQueue = result.catch(() => undefined)
    this.active.add(result)
    try { return await result } finally { this.active.delete(result) }
  }

  private async options(scope: ManagerScope) {
    const company = this.ctx.get('companyContent')
    const companySkillsRoot = company ? (await company.read()).skillsRoot : process.env.DSH_COMPANY_SKILLS_ROOT
    if (scope.workspace !== undefined) {
      const target = await resolveWorkspaceTarget(scope.workspace, registeredWorkspacePaths(this.ctx))
      if (!('root' in target)) throw new RemoteError('skills/operation', target.error, target)
      return { projectCwds: target.root.workspaceCwds ?? [], workspaceBound: true, companySkillsRoot, workspaceTarget: target.root }
    }
    return { projectCwds: activeSessionCwds(this.ctx, scope.sessionId), companySkillsRoot }
  }

  private async root(scope: ManagerScope & { root?: string }) {
    const options = await this.options(scope)
    if (options.workspaceTarget) {
      if (scope.root === undefined || scope.root === 'dsh') return options.workspaceTarget
      return (await projectRoots(options.projectCwds)).find(root => root.key === scope.root)
    }
    return userRoots(options.companySkillsRoot).find(root => root.key === (scope.root ?? 'dsh')) ?? (await projectRoots(options.projectCwds)).find(root => root.key === scope.root)
  }

  private async attachSources<T extends { roots: RootView[]; warnings: Diagnostic[] }>(snapshot: T) {
    try {
      const sources = await this.repositories.sources()
      for (const root of snapshot.roots) {
        const realRoot = await realpath(root.path).catch(() => root.path)
        for (const skill of root.skills) skill.installSource = sources[installationSourceKey(realRoot, skill.name)] ?? null
      }
    } catch (error) {
      snapshot.warnings.push({ code: 'error.repo.state', error: error instanceof Error ? error.message : String(error) })
    }
    return snapshot
  }

  /** Read current policy, sources and install ownership.
   * @param scope Explicit selected Session; no fallback to other Sessions.
   * @param refreshCompany Refresh the company catalog before reading.
   * @param signal Native invocation lifetime.
   * @returns Current management snapshot.
   */
  @Remote
  readState(scope: ManagerScope, refreshCompany: boolean, signal: AbortSignal): Promise<SkillManagerResults['readState']> {
    return this.perform(async () => {
      if (refreshCompany) await this.ctx.get('companyContent')?.refresh()
      return this.attachSources(await state(await this.options(scope)))
    }, signal, { mutation: refreshCompany, notify: refreshCompany })
  }

  /** List registered workspaces.
   * @param signal Native invocation lifetime.
   * @returns Available workspace destinations.
   */
  @Remote
  listWorkspaces(signal: AbortSignal): Promise<SkillManagerResults['listWorkspaces']> { return this.perform(async () => ({ items: await listWorkspaces(registeredWorkspacePaths(this.ctx) ?? []) }), signal) }

  /** Read skills only within a registered workspace.
   * @param workspace Host-registered directory path.
   * @param signal Native invocation lifetime.
   * @returns Project skill sources and diagnostics.
   */
  @Remote
  readWorkspace(workspace: string, signal: AbortSignal): Promise<SkillManagerResults['readWorkspace']> {
    return this.perform(async () => {
      const snapshot = await workspaceSkills(workspace, registeredWorkspacePaths(this.ctx))
      return 'roots' in snapshot ? this.attachSources(snapshot) : snapshot
    }, signal)
  }

  /** Browse readable import directories.
   * @param path Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  browse(path: string, signal: AbortSignal): Promise<SkillManagerResults['browse']> { return this.perform(() => browseDirectories(path), signal) }

  /** Read one skill within its explicit source.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  readDetail(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['readDetail']> { return this.perform(async () => skillDetail(target.root, target.name ?? '', await this.options(target)), signal) }

  /** Prepare a personal skill for company submission.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  exportSkill(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['exportSkill']> { return this.perform(async () => exportSkill(target.root, target.name ?? '', await this.options(target)), signal) }

  /** Set one skill invocation policy.
   * @param target Explicit operation input.
   * @param enabled Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  setSkillEnabled(target: ManagerTarget, enabled: boolean, signal: AbortSignal): Promise<SkillManagerResults['setSkillEnabled']> { return this.perform(async () => setSkillEnabled(await this.root(target), target.name ?? '', enabled, this.log), signal, { mutation: true, notify: true }) }

  /** Set one source invocation policy.
   * @param target Explicit operation input.
   * @param enabled Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  setSourceEnabled(target: ManagerTarget, enabled: boolean, signal: AbortSignal): Promise<SkillManagerResults['setSourceEnabled']> { return this.perform(async () => setSourceEnabled(target.root, enabled, this.log, await this.options(target)), signal, { mutation: true, notify: true }) }

  /** Create a list category.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  createCategory(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['createCategory']> { return this.perform(async () => createCategory(target.root, target.name ?? '', this.log, await this.options(target)), signal, { mutation: true }) }

  /** Rename a list category.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  renameCategory(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['renameCategory']> { return this.perform(async () => renameCategory(target.root, target.id ?? '', target.name ?? '', this.log, await this.options(target)), signal, { mutation: true }) }

  /** Delete a list category while retaining its skills.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  deleteCategory(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['deleteCategory']> { return this.perform(async () => deleteCategory(target.root, target.id ?? '', this.log, await this.options(target)), signal, { mutation: true }) }

  /** Assign a skill to a category.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  assignCategory(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['assignCategory']> { return this.perform(async () => assignSkillCategory(target.root, target.name ?? '', target.category ?? '', this.log, await this.options(target)), signal, { mutation: true }) }

  /** Change category ordering.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  moveInCategory(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['moveInCategory']> { return this.perform(async () => moveSkillInCategory(target.root, target.name ?? '', target.category ?? '', target.targetName, target.position ?? 'before', this.log, await this.options(target)), signal, { mutation: true }) }

  /** Set invocation policy for a category.
   * @param target Explicit operation input.
   * @param enabled Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  setCategoryEnabled(target: ManagerTarget, enabled: boolean, signal: AbortSignal): Promise<SkillManagerResults['setCategoryEnabled']> { return this.perform(async () => setCategoryEnabled(target.root, target.category ?? '', enabled, this.log, await this.options(target)), signal, { mutation: true, notify: true }) }

  /** Move a writable skill into the recoverable trash.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  trashSkill(target: ManagerTarget, signal: AbortSignal): Promise<SkillManagerResults['trashSkill']> { return this.perform(async () => this.repositories.trashSkill(await this.root(target), target.name ?? ''), signal, { mutation: true, notify: true }) }

  /** Restore a trash item only to its registered original destination.
   * @param id Explicit operation input.
   * @param scope Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  restoreTrash(id: string, scope: ManagerScope, signal: AbortSignal): Promise<SkillManagerResults['restoreTrash']> { return this.perform(async () => this.repositories.restoreTrash(id, { ...await this.options(scope), registeredWorkspaces: registeredWorkspacePaths(this.ctx) }), signal, { mutation: true, notify: true }) }

  /** Permanently delete one trash item.
   * @param id Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  deleteTrash(id: string, signal: AbortSignal): Promise<SkillManagerResults['deleteTrash']> { return this.perform(() => this.repositories.permanentlyDeleteTrash(id), signal, { mutation: true }) }

  /** Create a skill in a writable destination.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  createSkill(request: ManagerImport, signal: AbortSignal): Promise<SkillManagerResults['createSkill']> { return this.perform(async () => createSkill({ name: request.name, description: request.description, body: request.body }, this.log, { root: await this.root(request) }), signal, { mutation: true, notify: true }) }

  /** Preview or import local skill files without changing source files.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  importSkill(request: ManagerImport, signal: AbortSignal): Promise<SkillManagerResults['importSkill']> { return this.perform(async () => importSkill(request.source ?? '', this.log, { conflict: request.conflict ?? 'skip', dryRun: request.dryRun === true, ...request.workspace !== undefined || request.root === 'agents' ? { root: await this.root(request) } : {} }), signal, { mutation: true, notify: request.dryRun !== true }) }

  /** Import a bounded file or ZIP upload.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  uploadSkill(request: ManagerImport, signal: AbortSignal): Promise<SkillManagerResults['uploadSkill']> { return this.perform(async () => {
    if (Buffer.byteLength(JSON.stringify(request)) > (88 << 20)) throw new RemoteError('skills/operation', 'body too large', { error: 'body too large', code: 'error.proto.bodyTooLarge' })
    return importUploadedSkill({ name: request.name, entries: request.entries, zip: request.zip }, this.log, { conflict: request.conflict ?? 'skip', ...request.workspace !== undefined || request.root === 'agents' ? { root: await this.root(request) } : {} }) }, signal, { mutation: true, notify: true }) }

  /** Read repositories and installed copies.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  listRepositories(signal: AbortSignal): Promise<SkillManagerResults['listRepositories']> { return this.perform(() => this.repositories.list(), signal) }

  /** Register a supported repository source.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  addRepository(request: RepositoryInput, signal: AbortSignal): Promise<SkillManagerResults['addRepository']> { return this.perform(() => this.repositories.add(request), signal, { mutation: true }) }

  /** Remove a repository registration.
   * @param id Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  removeRepository(id: string, signal: AbortSignal): Promise<SkillManagerResults['removeRepository']> { return this.perform(() => this.repositories.remove({ id }), signal, { mutation: true }) }

  /** Refresh remote metadata without blocking other local mutations.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  refreshRepository(request: { id: string }, signal: AbortSignal): Promise<SkillManagerResults['refreshRepository']> { return this.perform(active => this.repositories.refresh(request, active), signal) }

  /** Read a repository skill at the recorded revision.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  readRepository(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['readRepository']> { return this.perform(() => this.repositories.detail(request), signal) }

  /** Install a repository skill in a registered destination.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  installRepository(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['installRepository']> { return this.perform(() => this.repositories.install(request, registeredWorkspacePaths(this.ctx)), signal, { mutation: true, notify: true }) }

  /** Uninstall one recorded copy.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  uninstallRepository(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['uninstallRepository']> { return this.perform(() => this.repositories.uninstall(request), signal, { mutation: true, notify: true }) }

  /** Prepare an update preview and conflict token.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  previewUpdate(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['previewUpdate']> { return this.perform(() => this.repositories.preview(request), signal) }

  /** Apply a confirmed repository update.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  updateRepository(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['updateRepository']> { return this.perform(() => this.repositories.update(request), signal, { mutation: true, notify: true }) }

  /** Restore a recorded repository version.
   * @param request Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  rollbackRepository(request: SkillRequest, signal: AbortSignal): Promise<SkillManagerResults['rollbackRepository']> { return this.perform(() => this.repositories.rollback(request), signal, { mutation: true, notify: true }) }

  /** Read a bounded public market page.
   * @param options Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  listClawHub(options: ManagerMarketOptions, signal: AbortSignal): Promise<SkillManagerResults['listClawHub']> { return this.perform(active => listClawHub(options, fetch, active), signal) }

  /** Search the public ClawHub market.
   * @param query Explicit operation input.
   * @param options Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  searchClawHub(query: string, options: ManagerMarketOptions, signal: AbortSignal): Promise<SkillManagerResults['searchClawHub']> { return this.perform(active => searchClawHub(query, options, fetch, active), signal) }

  /** Search the public skills.sh market.
   * @param query Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  searchSkillsSh(query: string, signal: AbortSignal): Promise<SkillManagerResults['searchSkillsSh']> { return this.perform(active => searchSkillsSh(query, fetch, active), signal) }

  /** Read a selected market skill.
   * @param target Explicit operation input.
   * @param signal Native invocation lifetime.
   * @returns The committed result or a typed operation failure.
   */
  @Remote
  readCatalog(target: CatalogIdentity, signal: AbortSignal): Promise<SkillManagerResults['readCatalog']> { return this.perform(active => readCatalogSkill(target, fetch, active), signal) }

  /** Download a market skill before serializing its local installation.
   * @param target Exact market identity.
   * @param destination Writable user or registered project location.
   * @param signal Native invocation lifetime; cancellation before commit leaves no install.
   * @returns Installed skill identity and source.
   */
  @Remote
  installCatalog(target: CatalogIdentity, destination: ManagerImport, signal: AbortSignal): Promise<SkillManagerResults['installCatalog']> {
    return this.perform(async (active) => {
      if (destination.root !== undefined && destination.root !== 'dsh' && destination.root !== 'agents') throw new RemoteError('skills/operation', '技能安装位置无效', { code: 'error.repo.invalid', error: '技能安装位置无效' })
      if (destination.workspace !== undefined && destination.root !== undefined && destination.root !== 'dsh') throw new RemoteError('skills/operation', '工作区只能安装到项目 DSH skills', { code: 'error.repo.invalid', error: '工作区只能安装到项目 DSH skills' })
      await this.options(destination)
      const pack = await loadCatalogPackage(target, fetch, active)
      const id = target.catalog === 'skillsh' ? `skillsh:${target.source}/${target.skillId}` : `clawhub:${target.owner}/${target.slug}`
      return this.perform(() => this.repositories.installCatalog(id, pack, destination), active, { mutation: true, notify: true })
    }, signal)
  }
}
