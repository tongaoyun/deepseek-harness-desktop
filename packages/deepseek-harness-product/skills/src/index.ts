/** Builtin skills use the native registry and Remote carrier; files remain owned by this module. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { makeLog } from './log.ts';
import { SkillsManager } from './manager.ts';
import { notifyChatCatalog, externalSkillProvider, registerAgentSkillProviders } from './host-runtime.ts';
import { TYPERT } from './generated/typert.host.js';
import type {} from '@deepseek-ai/dsh-typert-registry';
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry';
export { SkillsManager } from './manager.ts';
export const name = 'skills-manager';
export const inject = ['skills', 'tools', 'sessions', 'typert'];
const createInput = z.object({ name: z.string(), description: z.string(), body: z.string() }).strict();

/** Register native skill policy, typed management operations and the existing creation tool.
 * @param ctx Product Host context.
 */
export function apply(ctx: Context) {
  const log = makeLog();
  const invalidators = new Set<() => void>();
  const afterWrite = () => notifyChatCatalog(ctx, invalidators);
  ctx.typert.register(TYPERT as TypertContribution);
  const manager = ctx.plugin(SkillsManager, { log, afterWrite });
  const companySource = ctx.get('companyContent');
  ctx.effect(() => ctx.skills.registerProvider(control => externalSkillProvider(control, invalidators,
    companySource ? async () => (await companySource.read()).skillsRoot : undefined)), 'skills-manager global external skills provider');
  ctx.effect(() => registerAgentSkillProviders(ctx, invalidators), 'skills-manager agent-scoped external skills providers');
  ctx.effect(() => ctx.tools.register({
    name: 'create_skill',
    description: 'Create a new local DSH skill in DSH_HOME/skills. Use only when the user explicitly asks to create or save a reusable skill.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Skill name; it will be normalized to kebab-case.' },
      description: { type: 'string', description: 'A concise routing description for when to use the skill.' },
      body: { type: 'string', description: 'Markdown instructions that form the skill body.' },
    }, required: ['name', 'description', 'body'], additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, result) => {
        // This output was produced by createSkill through the manager below.
        const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
        return [{ type: 'text', text: value.ok === false ? `Skill creation failed${typeof value.code === 'string' ? ` (${value.code})` : ''}.` : `Created DSH skill ${value.name} at ${value.path}` }];
      },
    },
    async execute(args, exec) {
      await manager.await();
      try { return await ctx.skillsManager.createSkill(createInput.parse(args), exec.signal); }
      catch (error) {
        if (error instanceof Error && 'details' in error && error.details && typeof error.details === 'object' && 'error' in error.details) return { ok: false, ...error.details };
        throw error;
      }
    },
    presentCall(args) {
      const parsed = createInput.safeParse(args);
      return { card: 'generic', title: 'Create DSH skill', kind: 'edit', rawInput: parsed.success ? parsed.data.name : undefined };
    },
  }), 'skills-manager create_skill tool');
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'create_skill'
    ? Promise.resolve({ kind: 'ask' as const, reason: 'Create a new skill under DSH_HOME/skills' }) : next());
}
