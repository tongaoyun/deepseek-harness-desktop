import type { ClawHubPage, ClawHubSearchResponse } from './clawhub-catalog.ts';
import type * as React from 'react';
import type { createRepositoryManager } from './repositories.ts';
import type { state, skillDetail, createSkill, listTrash, listWorkspaces, workspaceSkills } from './core.ts';
import type { ImportResult } from './types.ts';
export type Translate = (key: string, params?: object) => string;
type Success<T> = T extends {
    error: string;
} ? never : T;
export type ManagerSnapshot = Awaited<ReturnType<typeof state>>;
export type Detail = Success<Awaited<ReturnType<typeof skillDetail>>>;
export type TrashItem = Awaited<ReturnType<typeof listTrash>>[number];
type Manager = ReturnType<typeof createRepositoryManager>;
export type RepositoryRoutes = {
    [K in keyof Manager as K extends 'sources' | 'list' | 'restoreTrash' | 'rememberCatalogInstall' | 'forgetCatalogInstall' | 'installCatalog' | 'trashSkill' | 'permanentlyDeleteTrash' ? never : `/repositories/${K}`]: Awaited<ReturnType<Manager[K]>>;
};
type SkillsShSearchPath = `/skills-sh/search?q=${string}`;
type SkillsShSearchResult = { skills: { id: string; source: string; skillId: string; name: string; installs?: number }[] };
export type ApiRoutes = RepositoryRoutes & Record<SkillsShSearchPath, SkillsShSearchResult> & Record<`/clawhub/list?${string}`, ClawHubPage> & Record<`/clawhub/search?${string}`, ClawHubSearchResponse> & {
    '/repositories': Awaited<ReturnType<Manager['list']>>;
    '/state': ManagerSnapshot;
    '/state?refreshCompany=1': ManagerSnapshot;
    '/workspaces': { items: Awaited<ReturnType<typeof listWorkspaces>> };
    '/workspace-skills': Success<Awaited<ReturnType<typeof workspaceSkills>>>;
    '/import': ImportResult;
    '/catalog/detail': { name: string; description: string; body: string; origin: string };
    '/catalog/install': { name: string; root: string };
    '/detail': Detail;
    '/export': { resourceKey: string; files: Record<string, string> };
    '/create': Success<Awaited<ReturnType<typeof createSkill>>>;
    '/upload': ImportResult;
    '/delete': unknown;
    '/trash-restore': unknown;
    '/trash-delete': unknown;
    '/enable': unknown;
    '/disable': unknown;
    '/source-enable': unknown;
    '/source-disable': unknown;
    '/category-create': unknown;
    '/category-rename': unknown;
    '/category-delete': unknown;
    '/category-assign': unknown;
    '/category-move': unknown;
    '/category-enable': unknown;
    '/category-disable': unknown;
};
export type ApiCall = <K extends keyof ApiRoutes>(path: K, options?: RequestInit) => Promise<ApiRoutes[K]>;
export interface ModalProps {
    title: string;
    closeLabel: string;
    onClose: () => void;
    description?: string;
    footer?: React.ReactNode;
    children?: React.ReactNode;
    wide?: boolean;
    className?: string;
    contentClassName?: string;
}
export interface SourceSelectProps {
    value?: string;
    label: string;
    disabled?: boolean;
    action?: boolean;
    icon?: React.ReactNode;
    options: {
        value: string;
        label: React.ReactNode;
        disabled?: boolean;
        danger?: boolean;
    }[];
    onChange: (value: string) => void;
}
export interface SessionSnapshot {
    ids?: string[];
    byId?: Record<string, {
        retainedBy?: {
            mainView?: unknown;
        };
    }>;
}
export interface SectionProps {
    t: Translate;
    useSessions?: (selector: (snapshot?: SessionSnapshot) => string | undefined) => string | undefined;
}
export interface Filters {
    query: string;
    source: string;
    status: string;
}
export interface ViewProps extends SectionProps {
    sessionId?: string;
    scope: string;
    setScope: React.Dispatch<React.SetStateAction<string>>;
    savedFilters: Record<string, Filters>;
    setSavedFilters: React.Dispatch<React.SetStateAction<Record<string, Filters>>>;
    expanded: Record<string, boolean>;
    setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
}
export type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
/** 文件夹选择器的非标准属性由 Chromium/DSH 提供。 */
declare module 'react' {
    interface InputHTMLAttributes<T> {
        webkitdirectory?: string;
        directory?: string;
    }
}
