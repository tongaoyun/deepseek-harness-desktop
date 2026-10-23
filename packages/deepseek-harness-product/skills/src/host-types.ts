import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanyContentSource } from '@deepseek-harness/product/protocol';
import type { CreateInput, ScopeOptions } from './types.ts';
import type { ProviderCandidate, createSkill, getProviderSkill } from './core.ts';
/** 产品技能模块使用的宿主服务契约。 */
export interface ProviderControl {
    invalidate: () => void;
    signal?: AbortSignal;
}
interface SkillProvider {
    name: string;
    list: (options?: ScopeOptions) => Promise<ProviderCandidate[]>;
    get: (candidate: ProviderCandidate, options?: ScopeOptions) => ReturnType<typeof getProviderSkill>;
}
interface Skills {
    registerProvider: (factory: (control: ProviderControl) => SkillProvider) => (() => void);
}
interface Session {
    id: string;
    header: {
        cwd?: string;
        agentPreset?: string;
    };
}
/** 当前宿主登记的工作区；路径只取公开的 path 字段。 */
interface WorkspaceRegistry {
    list: () => Iterable<{ path: string }>;
}
interface Sessions {
    list: () => Session[];
    get: (id: string) => Session | undefined;
}
export interface Agent {
    id: string;
    ctx: {
        skills?: Skills;
        get: (key: 'skills') => Skills | undefined;
    };
}
interface Services {
    companyContent: CompanyContentSource;
    workspaceRegistry: WorkspaceRegistry;
    sessions: Sessions;
    agents: {
        list: () => Agent[];
    };
}
export interface HostContext {
    get: <K extends keyof Services>(key: K) => Services[K] | undefined;
    sessions: Sessions;
    skills: Skills;
    root: { webStartup?: { trustedHosts: string[] } };
    webServer: {
        register: (route: {
            kind: string;
            path: string;
            handler: (req: IncomingMessage, res: ServerResponse) => unknown;
        }) => () => void;
    };
    logger: {
        warn: (message: string) => void;
    };
    effect: (effect: () => (() => void) | void, label: string) => unknown;
    emit: (event: string, ...args: unknown[]) => unknown;
    on: {
        (event: 'agent/created' | 'agent/disposed', handler: (event: {
            agent: Agent;
        }) => void): (() => void);
        (event: 'tools/pre-execute', handler: (execution: {
            name: string;
        }, next: () => unknown) => unknown): (() => void);
    };
    tools?: {
        register: (tool: {
            name: string;
            description: string;
            parameters: unknown;
            output: {
                schema: unknown;
                render: (args: CreateInput, value: Awaited<ReturnType<typeof createSkill>>) => {
                    type: string;
                    text: string;
                }[];
            };
            execute: (args: CreateInput) => ReturnType<typeof createSkill>;
            presentCall: (args: CreateInput) => {
                card: string;
                title: string;
                kind: string;
                rawInput?: string;
            };
        }) => () => void;
    };
}
