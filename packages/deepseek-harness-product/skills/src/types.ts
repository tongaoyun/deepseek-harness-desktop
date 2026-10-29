import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type {} from '@deepseek-ai/dsh-typert-protocol';

declare module '@deepseek-ai/dsh-typert-protocol' {
    interface RemoteErrorDetailsMap { 'skills/operation': Diagnostic & { error: string } }
}
/** 全局与项目来源共用的目录契约；项目字段只在项目来源存在。 */
export interface SkillRoot {
    key: string;
    path: string;
    label: string;
    rank: number;
    mutable: boolean;
    native: boolean;
    toggleable: boolean;
    scope?: string;
    kind?: string;
    localeKey?: string;
    projectRoot?: string;
    projectName?: string;
    workspaceCwds?: string[];
    ok?: true;
}
/** Root accepted by local operations; unresolved roots are rejected by the operation. */
export type RootInput = SkillRoot | string | null | undefined;
/** Localized diagnostic code, JSON interpolation values and optional technical detail. */
export interface Diagnostic {
    code?: string;
    params?: Record<string, JsonValue>;
    error?: string;
    level?: string;
}
/** Expected operation failure; no successful result is implied. */
export interface OperationError extends Diagnostic {
    ok: false;
    error: string;
}
/** Thrown diagnostic retaining its cause and existing transport status metadata. */
export interface CodedError extends Error {
    code?: string;
    params?: Record<string, JsonValue>;
    statusCode?: number;
    httpStatus?: number;
}
/** Diagnostic writer owned by one manager instance. */
export type Log = (event: string, detail: unknown) => void | Promise<void>;
/** Filesystem discovery result with resolved paths and link ownership. */
export interface DiscoveredEntry {
    name?: string;
    kind: string;
    docPath: string;
    entryPath: string;
    realDocPath: string;
    realEntryPath: string;
    linked: boolean;
}
/** Parsed discovery entry with native invocation rules and diagnostics. */
export interface SkillEntry extends DiscoveredEntry {
    name: string;
    declaredName: string;
    description: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    invocationPolicyValid: boolean;
    hasFrontmatter: boolean;
    loadable: boolean;
    diagnostics: Diagnostic[];
    providerRank?: number;
    policyAliases?: {
        rootKey: string;
        name: string;
    }[];
}
/** Native YAML parse result and unmodified Markdown body. */
export interface ParsedSkill {
    data: Record<string, unknown>;
    map: Record<string, string>;
    body: string;
    hasFrontmatter: boolean;
}
/** Bounded scan result for one source directory. */
export interface Scan {
    exists: boolean;
    entries: SkillEntry[];
    truncated?: boolean;
}
/** Source-local list category identity and display name. */
export interface SkillCategory {
    id: string;
    name: string;
}
/** Persisted invocation overrides, categories and ordering. */
export interface ManagerState {
    version: number;
    sources: Record<string, boolean>;
    disabledSkills: Record<string, string[]>;
    enabledSkills: Record<string, string[]>;
    /** 每个来源自己的列表分类。 */
    categories: Record<string, SkillCategory[]>;
    categoryMembers: Record<string, Record<string, string>>;
    /** 每个来源、分类（空字符串代表未分类）里的手动排序。 */
    categoryOrder: Record<string, Record<string, string[]>>;
}
/** Loaded policy and whether subsequent writes are allowed. */
export interface PolicyResult {
    state: ManagerState;
    writable: boolean;
    warning: Diagnostic | null;
}
/** Effective invocation policy after source and skill overrides. */
export interface Policy {
    override?: boolean;
    sourceEnabled: boolean;
    modelInvocable: boolean;
    userInvocable: boolean;
    enabled: boolean;
}
/** Management row combining discovery, policy and installation ownership. */
export interface SkillView extends Omit<SkillEntry, 'docPath' | 'entryPath' | 'realDocPath' | 'realEntryPath' | 'linked'> {
    path: string;
    managerEnabled: boolean;
    managerOverride: boolean | null;
    effectiveModelInvocable: boolean;
    effectiveUserInvocable: boolean;
    enabled?: boolean;
    winner?: boolean;
    canonicalName?: string;
    shadowedBy?: {
        root: string;
        name: string;
    };
    fallbackTo?: {
        root: string;
        name: string;
        scope: string;
    };
    installSource?: InstallSource | null;
    categoryId?: string | null;
    /** 可写根里的顶层目录链接。详情和启停可用，删除与覆盖不可用。 */
    linked?: boolean;
}
/** Source directory and its bounded management rows. */
export interface RootView extends SkillRoot {
    exists: boolean;
    truncated: boolean;
    enabled: boolean;
    skills: SkillView[];
    categories: SkillCategory[];
    categoryOrder?: Record<string, string[]>;
}
/** Discovered entry joined with its source and effective invocation policy. */
export interface SkillItem {
    root: SkillRoot;
    entry: SkillEntry;
    policy: Policy;
}
/** Skill item joined with its management presentation. */
export interface ViewItem extends SkillItem {
    view: SkillView;
    managerEnabled: boolean;
}
/** Archive-relative path and content hash used to detect conflicting edits. */
export interface FileDigest {
    path: string;
    hash: string;
}
/** Archive entries keyed by validated relative paths. */
export type Archive = Record<string, Uint8Array>;
/** Repository revision and subdirectory selected by the user. */
export interface RepositorySource {
    owner: string;
    name: string;
    ref: string;
    subdirectory: string;
}
/** Repository skill content, validation state and revision hashes. */
export interface RepositorySkill {
    path: string;
    name: string;
    description: string;
    body: string;
    valid: boolean;
    documentHash: string;
    files?: FileDigest[];
}
/** Registered repository and the last fetched catalog or diagnostic. */
export interface Repository extends RepositorySource {
    id: string;
    skills: RepositorySkill[];
    commit: string | null;
    refreshedAt: string | null;
    error: Diagnostic | null;
}
/** Writable installation roots supported by the product manager. */
export type RepositoryRoot = 'dsh' | 'agents';
/** Resolved installation root and its availability diagnostic. */
export interface RepositoryDestination {
    key: RepositoryRoot;
    path: string;
    label: string;
    localeKey?: string;
    available: boolean;
    error?: Diagnostic;
}
/** Recorded repository origin for one installed copy. */
export interface InstallSource extends RepositorySource {
    root?: RepositoryRoot;
    workspace?: string;
    id: string;
    path: string;
    commit: string | null;
}
/** Persisted installed copy with exact destination and rollback ownership. */
export interface InstallRecord {
    /** 固定安装位置；恢复、更新和卸载不得推测位置。 */
    root: RepositoryRoot;
    /** 安装到已登记工作区时保存的项目根；缺省表示用户目录。更新、回滚、卸载都按它定位。 */
    workspace?: string;
    id: string;
    path: string;
    name: string;
    commit: string | null;
    complete: boolean;
    /** Retired ownership: retained only for explicit Trash restore. */
    trashId?: string;
    restoreFingerprint?: string;
    files: FileDigest[];
    source?: RepositorySource;
    backup?: {
        key: string;
        fingerprint: string;
        record: InstallRecord;
    };
}
/** Persisted public catalog copy with exact destination and file hashes. */
export interface CatalogInstallRecord {
    id: string;
    name: string;
    /** 固定安装位置，与内容摘要一起保存。 */
    root: RepositoryRoot;
    workspace?: string;
    /** 回收站中的副本不会把后来创建的同名技能认作原安装。 */
    trashId?: string;
    restoreFingerprint?: string;
    /** 文件落盘前记录精确摘要，确认失败后只恢复完全匹配的副本。 */
    complete: boolean;
    files: FileDigest[];
}
/** Persisted repository catalog and installation ownership records. */
export interface RepositoryState {
    version: number;
    repositories: Repository[];
    installs: InstallRecord[];
    catalogInstalls: CatalogInstallRecord[];
}
/** User-selected repository URL, revision and optional subdirectory. */
export interface RepositoryInput {
    url?: string;
    ref?: string;
    subdirectory?: string;
}
/** One recorded repository skill and the explicit installation operation options. */
export interface SkillRequest {
    root?: RepositoryRoot;
    /** 宿主实际登记路径；每次管理重新解析后与记录保存的项目根匹配。 */
    workspace?: string;
    id: string;
    path: string;
    rollback?: boolean;
    token?: string;
    overwrite?: boolean;
}
/** Serialize repository state operations; recovery is explicitly selected by the owner. */
export type Serialize = <T>(task: () => T | Promise<T>, recover?: boolean) => Promise<T>;
/** State, download and serialization capabilities supplied to repository operations. */
export interface RepositoryDependencies {
    registeredWorkspaces?: () => string[] | undefined;
    /** 测试用来观察是否真的扫描了登记工作区；生产调用不传。 */
    onWorkspaceIndexBuild?: () => void;
    read: () => Promise<RepositoryState>;
    write: (state: RepositoryState) => Promise<void>;
    repository: (state: RepositoryState, id: string) => Repository;
    download: (repo: Repository) => Promise<Archive>;
    serialize: Serialize;
    parseRepositoryInput: (input?: RepositoryInput) => RepositorySource;
}
/** Explicit filesystem lookup scope and optional reader cancellation. */
export interface ScopeOptions {
    /** Immutable root selected by the product catalog or this Agent's Session. */
    companySkillsRoot?: string;
    projectCwds?: string[];
    cwd?: string;
    signal?: AbortSignal;
}
/** Atomic rename retry capabilities supplied by a file transaction. */
export interface RenameOptions {
    rename?: (source: string, destination: string) => Promise<void>;
    maxAttempts?: number;
    delayMs?: number;
}
/** Internal filesystem mutation options; callbacks never cross Remote. */
export interface MutationOptions extends ScopeOptions {
    /** 宿主登记的工作区路径列表，由管理服务从 workspaceRegistry 读取；缺省表示不允许写项目。 */
    registeredWorkspaces?: string[];
    repositoryEntryOnly?: boolean;
    repositoryTrash?: { id: string; repository: { id: string; path: string } };
    /** 内部目录副本回收凭据，不从 Remote 请求读取。 */
    catalogTrash?: { id: string; ids: string[] };
    repositoryRestore?: boolean;
    root?: RootInput;
    renameOptions?: RenameOptions;
    conflict?: string;
    dryRun?: boolean;
    /** 内部安装事务在文件复制前持久化意图，不接受请求体回调。 */
    beforeImport?: (pending: ImportPending[], conflicts: ImportConflict[], failed: ImportFailure[]) => Promise<void>;
}
/** Base64 file entries or a base64 ZIP validated by the import executor. */
export interface UploadInput {
    name?: string;
    zip?: string;
    entries?: {
        path: string;
        data: string;
    }[];
}
/** Skill document fields validated by the creation executor. */
export interface CreateInput {
    name?: string;
    description?: string;
    body?: string;
}
/** Local source resolved to a normalized skill name. */
export interface ImportCandidate {
    source: string;
    kebab: string;
    rawName: string;
    isDir: boolean;
}
/** Validated source and destination awaiting import commit. */
export interface ImportPending {
    name: string;
    source: string;
    isDir: boolean;
    dest: string;
}
/** Existing destination paths requiring an explicit conflict decision. */
export interface ImportConflict {
    name: string;
    source: string;
    isDir: boolean;
    paths: string[];
}
/** One failed import source with a localized diagnostic. */
export interface ImportFailure extends Diagnostic {
    source: string;
    error: string;
}
/** Import outcome with committed, skipped, failed or previewed items. */
export interface ImportResult extends Diagnostic {
    ok?: boolean;
    kind?: string;
    imported?: {
        name: string;
        overwritten: boolean;
        warnings: Diagnostic[];
    }[];
    skipped?: {
        name: string;
        source: string;
    }[];
    failed?: ImportFailure[];
    pending?: ImportPending[];
    conflicts?: ImportConflict[];
}

/** Explicit UI scope; a workspace is always checked against the Host registry. */
export interface ManagerScope {
    sessionId?: string;
    workspace?: string;
}
/** A skill or category operation in one explicit source. */
export interface ManagerTarget extends ManagerScope {
    root: string;
    name?: string;
    id?: string;
    category?: string;
    targetName?: string;
    position?: 'before' | 'after';
}
/** Creation and import payload; only the operation's own fields are consumed. */
export interface ManagerImport extends ManagerScope, CreateInput, UploadInput {
    root?: string;
    source?: string;
    conflict?: 'overwrite' | 'skip';
    dryRun?: boolean;
}
/** Validated catalog source identity used for installation and updates. */
export type CatalogIdentity =
    | { catalog: 'clawhub'; owner: string; slug: string }
    | { catalog: 'skillsh'; source: string; skillId: string };
/** Bounded public catalog paging and sorting inputs. */
export interface ManagerMarketOptions { limit?: number; cursor?: string; sort?: string; }


/** Persisted trash entry and original restore location. */
export interface TrashMetadata { id: string; name: string; deletedAt: string; repository?: {id: string; path: string}; catalog?: string[]; root?: {key: string; scope: string; label: string; localeKey?: string; projectRoot?: string; projectName?: string; kind?: string}; entries: string[] }
export type { SkillManagerResults } from './generated/results.ts';
export type { WorkspaceRow } from './core.ts';
export type { ClawHubItem, ClawHubStats, ClawHubPage, ClawHubSearchItem, ClawHubSearchResponse } from './clawhub-catalog.ts';
export type { SkillsShSkill } from './skills-sh-catalog.ts';
