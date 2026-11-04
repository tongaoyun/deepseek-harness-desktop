/** AI-authored personal content saved through native tool approval and revision-checked libraries. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgencyExpertLibrary } from './expert-library.ts'
import type { AgencyTeamLibrary } from './team-library.ts'
import { customExpertInputSchema } from './expert-contract.ts'
import { matchMember } from './creation-contract.ts'
import { EXPERT_DIVISION_ORDER } from './names.ts'

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true }, markdown: { type: 'string', required: true },
  } } as const,
  render: (_args: unknown, value: { id: string; name: string; markdown: string }) => [{ type: 'text' as const, text: value.markdown }],
}

/** Register personal creation tools and their native approval policy.
 * @param ctx - Host registration context.
 * @param library - Revision-checked personal expert library.
 * @param teams - Revision-checked team library that freezes member versions.
 * @param locale - Current host locale reader.
 */
export function registerCreationTools(ctx: Context, library: AgencyExpertLibrary, teams: AgencyTeamLibrary, locale: () => 'zh' | 'en'): void {
  const text = (zh: string, en: string) => locale() === 'zh' ? zh : en
  const main = (exec: ToolRunContext) => {
    if (!exec.agent || exec.agent.session.header.parentSession !== undefined) throw new Error(text('请在主对话中创建专家或专家团', 'Create experts or teams in the main conversation.'))
    exec.signal.throwIfAborted()
  }
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name === 'create_custom_expert' || exec.name === 'create_expert_team') return Promise.resolve({
      kind: 'ask', reason: text('确认保存 AI 生成的个人内容；不会发布到公司市场。', 'Save AI-generated personal content. This does not publish to the company market.'),
    })
    return next()
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'create_custom_expert',
    description: 'Save a new personal AgentSpec expert after native human approval. Clarify the user’s needs and show the complete design in conversation first. Generate all fields yourself; never ask the user to fill a form. Does not overwrite existing experts or publish company content.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique display name, at most 40 characters.' },
      description: { type: 'string', required: true, description: 'Expertise summary, at most 160 characters.' },
      division: { type: 'string', required: true, description: 'Existing category ID from list_creation_experts.' },
      prompt: { type: 'string', required: true, description: 'Complete literal SOUL.md instructions: expertise, responsibilities, workflow, constraints and deliverables.' },
      agents: { type: 'string', description: 'Optional literal AGENTS.md working instructions.' },
      emoji: { type: 'string', description: 'One emoji.' },
      files: { type: 'array', description: 'Optional UTF-8 references and templates. Binary attachments can be added later in the library.', items: {
        type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', required: true, description: 'Relative package path under references/ or assets/.' },
          content: { type: 'string', required: true, description: 'Complete UTF-8 file contents, interpreted literally.' },
        },
      } },
    }, output,
    presentCall(args) { return { card: 'generic', kind: 'edit', title: text('创建专家', 'Create expert'), rawInput: JSON.stringify(args, null, 2) } },
    async execute(args, exec) {
      main(exec)
      const catalog = await library.catalog(exec.signal)
      const resources: Record<string, string> = {}
      for (const file of args.files ?? []) {
        if (!/^(references|assets)\//u.test(file.path) || Object.hasOwn(resources, file.path)) throw new Error(text('资料路径必须唯一，且位于 references/ 或 assets/ 下。', 'Resource paths must be unique and under references/ or assets/.'))
        resources[file.path] = Buffer.from(file.content).toString('base64')
      }
      const { files: _files, ...fields } = args
      const input = customExpertInputSchema.parse({ ...fields, resources })
      const saved = await library.saveCustom(input, true, catalog.revision, exec.signal)
      const created = saved.experts.find(item => item.custom && item.name === input.name)
      if (!created) throw new Error('Saved expert is missing from the catalog')
      return { id: created.slug, name: created.name, markdown: text(`已创建并启用专家「${created.name}」。可在「我的」中使用、编辑及管理资料。`, `Created and enabled expert “${created.name}”. Use it or manage its files in Mine.`) }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_creation_experts', description: 'List available experts and category IDs for creating personal experts or teams. Includes disabled experts. Use full slugs to resolve ambiguous names; excludes conflicting and company-team-only entries.',
    parameters: { query: { type: 'string', description: 'Optional Chinese/English name or slug filter.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      main(exec)
      const catalog = await library.catalog(exec.signal), query = args.query?.normalize('NFKC').trim().toLowerCase() ?? ''
      const matches = catalog.experts.filter(expert => !expert.conflict && !expert.teamMember && [expert.name, expert.nameEn, expert.slug].some(name => name.normalize('NFKC').toLowerCase().includes(query)))
      return JSON.stringify({
        categories: [...new Set([...EXPERT_DIVISION_ORDER, ...catalog.experts.map(expert => expert.division)])],
        total: matches.length, truncated: matches.length > 80,
        experts: matches.slice(0, 80).map(expert => ({
          slug: expert.slug, name: expert.name, nameEn: expert.nameEn, description: expert.description,
          division: expert.division, enabled: catalog.enabled.includes(expert.slug),
        })),
      })
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'create_expert_team', description: 'Save and enable a new personal team after native human approval. Design the goal, member duties and coordinator rules in conversation. Members must already exist. Saving freezes exact member versions. Does not overwrite or publish company content.',
    parameters: {
      name: { type: 'string', required: true }, description: { type: 'string', required: true },
      goal: { type: 'string', required: true }, constraints: { type: 'string', required: true }, deliveryRequirements: { type: 'string', required: true },
      tags: { type: 'array', required: true, items: { type: 'string' } }, examples: { type: 'array', required: true, items: { type: 'string' } },
      members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        expertSlug: { type: 'string', required: true, description: 'Full slug from list_creation_experts.' },
        duty: { type: 'string', required: true }, instructions: { type: 'string', required: true },
      } } },
      coordinatorTemplateId: { type: 'string', required: true, enum: ['general', 'product', 'technical', 'content', 'data', 'research'] },
      coordinatorPrompt: { type: 'string', description: 'Optional custom coordinator rules. Omit to use the selected template.' },
    }, output,
    presentCall(args) { return { card: 'generic', kind: 'edit', title: text('创建专家团', 'Create team'), rawInput: JSON.stringify(args, null, 2) } },
    async execute(args, exec) {
      main(exec)
      const catalog = await library.catalog(exec.signal)
      const members = args.members.map((member) => {
        const match = matchMember(catalog.experts, member.expertSlug)
        if (match.kind !== 'match') throw new Error(text('成员不明确或不可用，请指定完整标识：', 'Member is ambiguous or unavailable; use a full slug: ') + member.expertSlug + '\n' + JSON.stringify(match.candidates.map(expert => ({ slug: expert.slug, name: expert.name, nameEn: expert.nameEn }))))
        return { ...member, expertSlug: match.slug }
      })
      const saved = await teams.save({ ...args, members, coordinatorMode: args.coordinatorPrompt?.trim() ? 'custom' : 'template', coordinatorTemplateVersion: 1, coordinatorPrompt: args.coordinatorPrompt ?? '' }, true, catalog.revision, exec.signal)
      const created = saved.teams.find(item => !item.company && item.name === args.name.trim())
      if (!created) throw new Error('Saved team is missing from the catalog')
      return { id: created.id, name: created.name, markdown: text(`已创建并启用专家团「${created.name}」，成员版本已固定。可在「我的」中使用或编辑。`, `Created and enabled team “${created.name}” with fixed member versions. Use or edit it in Mine.`) }
    },
  })))
}
