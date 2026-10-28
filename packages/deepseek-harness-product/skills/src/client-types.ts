import type * as React from 'react';
import type { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import type { state, skillDetail, listTrash } from './core.ts';
export type Translate = (key: string, params?: object) => string;
type Success<T> = T extends {
    error: string;
} ? never : T;
export type ManagerSnapshot = Awaited<ReturnType<typeof state>>;
export type Detail = Success<Awaited<ReturnType<typeof skillDetail>>>;
export type TrashItem = Awaited<ReturnType<typeof listTrash>>[number];
export type { SkillApi, SkillMethod, SkillInput, SkillOutput } from './remote-client.ts';
/** Native modal properties accepted by the product layout wrapper. */
export type ModalProps = Pick<Extract<React.ComponentProps<typeof Modal>, { headless?: false }>,
    'title' | 'closeLabel' | 'onClose' | 'description' | 'footer' | 'children' | 'className' | 'contentClassName'>;
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
    api: import('./remote-client.ts').SkillApi;
    apiForSession: (sessionId?: string) => import('./remote-client.ts').SkillApi;
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
