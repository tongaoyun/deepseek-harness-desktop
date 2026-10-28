/** Results derive from the owning operations rather than a separate wire DTO copy. */
type Completed<T> = T extends { error: string } ? never : T
type CoreResult<K extends keyof typeof import('../src/core.ts')> = typeof import('../src/core.ts')[K] extends (...args: never[]) => infer T ? Completed<Awaited<T>> : never
type RepositoryManager = ReturnType<typeof import('../src/repositories.ts').createRepositoryManager>
type RepositoryResult<K extends keyof RepositoryManager> = Completed<Awaited<ReturnType<RepositoryManager[K]>>>
export interface SkillManagerResults {
  readState: CoreResult<'state'>
  browse: CoreResult<'browseDirectories'>
  readDetail: CoreResult<'skillDetail'>
  exportSkill: CoreResult<'exportSkill'>
  readWorkspace: CoreResult<'workspaceSkills'>
  setSkillEnabled: CoreResult<'setSkillEnabled'>
  setSourceEnabled: CoreResult<'setSourceEnabled'>
  createCategory: CoreResult<'createCategory'>
  renameCategory: CoreResult<'renameCategory'>
  deleteCategory: CoreResult<'deleteCategory'>
  assignCategory: CoreResult<'assignSkillCategory'>
  moveInCategory: CoreResult<'moveSkillInCategory'>
  setCategoryEnabled: CoreResult<'setCategoryEnabled'>
  createSkill: CoreResult<'createSkill'>
  importSkill: CoreResult<'importSkill'>
  uploadSkill: CoreResult<'importUploadedSkill'>
  listRepositories: RepositoryResult<'list'>
  addRepository: RepositoryResult<'add'>
  removeRepository: RepositoryResult<'remove'>
  refreshRepository: RepositoryResult<'refresh'>
  readRepository: RepositoryResult<'detail'>
  installRepository: RepositoryResult<'install'>
  uninstallRepository: RepositoryResult<'uninstall'>
  previewUpdate: RepositoryResult<'preview'>
  updateRepository: RepositoryResult<'update'>
  rollbackRepository: RepositoryResult<'rollback'>
  trashSkill: RepositoryResult<'trashSkill'>
  restoreTrash: RepositoryResult<'restoreTrash'>
  deleteTrash: RepositoryResult<'permanentlyDeleteTrash'>
  installCatalog: RepositoryResult<'installCatalog'>
  listWorkspaces: { items: CoreResult<'listWorkspaces'> }
  listClawHub: Awaited<ReturnType<typeof import('../src/clawhub-catalog.ts').listClawHub>>
  searchClawHub: Awaited<ReturnType<typeof import('../src/clawhub-catalog.ts').searchClawHub>>
  searchSkillsSh: Awaited<ReturnType<typeof import('../src/skills-sh-catalog.ts').searchSkillsSh>>
  readCatalog: Awaited<ReturnType<typeof import('../src/catalog-skill.ts').readCatalogSkill>>
}
