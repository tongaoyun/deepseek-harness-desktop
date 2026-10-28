/** Generated from owning operation results by scripts/generate-remote.ts. Do not edit. */
export interface SkillManagerResults {
  readState: { roots: import("../types.ts").RootView[]; writeDestinations: import("../types.ts").RepositoryDestination[]; projects: { root?: string | undefined; name?: string | undefined; workspaceCwds?: string[] | undefined; }[]; summary: { total: number; enabled: number; disabled: number; issues: number; }; trash: import("../types.ts").TrashMetadata[]; warnings: import("../types.ts").Diagnostic[]; };
  browse: { path: string; home: string; crumbs: { name: string; path: string; hidden: boolean; }[]; entries: { name: string; path: string; hidden: boolean; }[]; truncated: boolean; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  readDetail: { root: string; name: string; declaredName: string; description: string; path: string; kind: string; body: string; document: string; frontmatter: { [k: string]: string; } | null; diagnostics: ({ level: string; code: string; params?: undefined; } | { level: string; code: string; params: { name: string; }; })[]; loadable: boolean; sourceReadOnly: boolean; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  exportSkill: { resourceKey: string; files: Record<string, string>; };
  readWorkspace: { project: { root: string; name: string; workspaceCwds: string[]; }; roots: import("../types.ts").RootView[]; warnings: import("../types.ts").Diagnostic[]; };
  setSkillEnabled: { root: string; name: string; enabled: boolean; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  setSourceEnabled: { root: string; enabled: boolean; };
  createCategory: { root: string; category: { id: string; name: string; }; };
  renameCategory: { root: string; category: import("../types.ts").SkillCategory; };
  deleteCategory: { root: string; id: string; };
  assignCategory: { root: string; name: string; categoryId: string | null; };
  moveInCategory: { root: string; name: string; categoryId: string | null; order: string[]; };
  setCategoryEnabled: { root: string; categoryId: string | null; enabled: boolean; changed: number; skipped: string[]; };
  createSkill: { name: string; path: string; root: string; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  importSkill: import("../types.ts").ImportResult;
  uploadSkill: import("../types.ts").ImportResult;
  listRepositories: { installRoots: import("../types.ts").RepositoryDestination[]; catalogInstalls: string[]; catalogCopies: { id: string; name: string; installedRoot: "dsh" | "agents"; installedWorkspace?: string | undefined; canUninstall: boolean; }[]; catalogWarnings: { id: string; code: string; error: string; }[]; repositories: { skills: { installations: { tracked: true; updateAvailable: boolean; canRollback: boolean; canUninstall: boolean; status: string; installedWorkspace?: string | undefined; installedRoot: import("../types.ts").RepositoryRoot; }[]; status: string; path: string; name: string; description: string; valid: boolean; documentHash: string; files?: import("../types.ts").FileDigest[] | undefined; }[]; id: string; commit: string | null; refreshedAt: string | null; error: import("../types.ts").Diagnostic | null; owner: string; name: string; ref: string; subdirectory: string; }[]; };
  addRepository: import("../types.ts").Repository;
  removeRepository: { id: string; };
  refreshRepository: import("../types.ts").Repository;
  readRepository: { commit: string | null; path: string; name: string; description: string; body: string; valid: boolean; documentHash: string; files?: import("../types.ts").FileDigest[] | undefined; };
  installRepository: { name: string; commit: string | null; root: string; };
  uninstallRepository: { id: string; name: string; deletedAt: string; root: { localeKey?: string | undefined; key: string; scope: string; label: string; } | { label: string; projectName?: string | undefined; key: string; scope: string; kind: string; projectRoot: string; }; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  previewUpdate: { token: string; commit: string | null; localModified: boolean; changes: { path: string; kind: string; }[]; rollback: boolean; };
  updateRepository: { name: string; commit: string | null; };
  rollbackRepository: { name: string; commit: string | null; };
  trashSkill: { id: string; name: string; deletedAt: string; root: { localeKey?: string | undefined; key: string; scope: string; label: string; } | { label: string; projectName?: string | undefined; key: string; scope: string; kind: string; projectRoot: string; }; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  restoreTrash: { id: string; name: string; root: { localeKey?: string | undefined; key: string; scope: string; label: string; } | { label: string; projectName?: string | undefined; key: string; scope: string; kind: string; projectRoot: string; }; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  deleteTrash: { id: string; name: string; ok?: undefined; error?: undefined; code?: undefined; params?: undefined; };
  installCatalog: { name: string; root: string; };
  listWorkspaces: { items: import("../core.ts").WorkspaceRow[]; };
  listClawHub: { items: import("../clawhub-catalog.ts").ClawHubItem[]; nextCursor: string | null; };
  searchClawHub: { results: import("../clawhub-catalog.ts").ClawHubSearchItem[]; };
  searchSkillsSh: { skills: import("../skills-sh-catalog.ts").SkillsShSkill[]; };
  readCatalog: { name: string; description: string; body: string; origin: string; };
}
