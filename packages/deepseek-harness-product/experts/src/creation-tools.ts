/** Model tools stage personal drafts and request native human confirmation; they never persist content. */
import { EXPERT_DIVISION_ORDER } from './names.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { AgencyExpertLibrary } from './expert-library.ts'
import type { CreationDrafts } from './creation.ts'
import { creationDraftSchema, matchMember, renderDraft } from './creation-contract.ts'

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    proposalId: { type: 'string', required: true }, markdown: { type: 'string', required: true }, ready: { type: 'boolean', required: true },
  } } as const,
  presentationMeta: (_args: unknown, value: { proposalId: string; markdown: string; ready: boolean }) => ({
    proposalId: value.proposalId, ready: value.ready,
  }),
  render: (_args: unknown, value: { proposalId: string; markdown: string; ready: boolean }) => [{ type: 'text' as const, text: value.markdown }],
}
/** Register creation tools with fiber-owned disposal.
 * @param ctx - Host registration context.
 * @param drafts - Plugin-owned expiring registry.
 * @param library - Current personal/company catalog.
 * @param locale - Current host locale reader.
 */
export function registerCreationTools(ctx: Context, drafts: CreationDrafts, library: AgencyExpertLibrary, locale: () => 'zh' | 'en'): void {
  const text = (zh: string, en: string) => locale() === 'zh' ? zh : en
  const session = (exec: ToolRunContext) => {
    if (!exec.agent || exec.agent.session.header.parentSession !== undefined) throw new Error(text('请在主对话中创建专家或专家团', 'Create experts or teams in the main conversation.'))
    exec.signal.throwIfAborted()
    return exec.agent.session.id
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'propose_custom_expert',
    description: 'Create or revise a personal expert draft. Show the full preview and invite changes. No content is saved. After explicit user confirmation, call open_custom_expert_editor with the returned proposalId.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique expert name, at most 40 characters.' },
      description: { type: 'string', required: true, description: 'Expertise summary, at most 160 characters.' },
      division: { type: 'string', required: true, description: 'An existing category ID from list_creation_experts.' },
      prompt: { type: 'string', required: true, description: 'Complete persona, responsibilities, constraints and deliverables, at most 20000 characters.' },
      emoji: { type: 'string', description: 'One emoji.' },
    }, output,
    async execute(args, exec) {
      const id = session(exec), catalog = await library.catalog()
      const input = creationDraftSchema.parse({ kind: 'expert', data: args })
      if (input.kind !== 'expert') throw new Error('Expected expert draft')
      const division = input.data.division
      if (!EXPERT_DIVISION_ORDER.some(value => value === division) && !catalog.experts.some(expert => expert.division === division)) throw new Error(text('请选择名册已有分类', 'Choose an existing catalog category.'))
      exec.signal.throwIfAborted()
      const proposal = drafts.save(id, input)
      return { proposalId: proposal.id, markdown: renderDraft(proposal.draft, locale(), catalog.experts), ready: false }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_creation_experts', description: 'List available experts (including disabled experts) for designing a team. Use full slugs to resolve ambiguous names. Conflict entries and embedded company-team members are excluded.',
    parameters: { query: { type: 'string', description: 'Optional Chinese/English name or slug filter.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      session(exec)
      const catalog = await library.catalog(), query = args.query?.normalize('NFKC').trim().toLowerCase() ?? ''
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
    name: 'propose_expert_team', description: 'Design or revise a personal expert team draft from existing experts. Show members, duties, instructions, goal and coordinator rules. No content is saved. After explicit confirmation call open_expert_team_editor with proposalId.',
    parameters: {
      name: { type: 'string', required: true }, description: { type: 'string', required: true },
      goal: { type: 'string', required: true }, constraints: { type: 'string', required: true }, deliveryRequirements: { type: 'string', required: true },
      tags: { type: 'array', required: true, items: { type: 'string' } }, examples: { type: 'array', required: true, items: { type: 'string' } },
      members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        expertSlug: { type: 'string', required: true, description: 'Full slug, Chinese/English name or unambiguous abbreviation from list_creation_experts.' },
        duty: { type: 'string', required: true }, instructions: { type: 'string', required: true },
      } } },
      coordinatorTemplateId: { type: 'string', required: true, enum: ['general', 'product', 'technical', 'content', 'data', 'research'] },
      coordinatorPrompt: { type: 'string', description: 'Optional custom coordinator rules. Omit to use the selected template.' },
    }, output,
    async execute(args, exec) {
      const id = session(exec), catalog = await library.catalog()
      const members = args.members.map((member) => {
        const match = matchMember(catalog.experts, member.expertSlug)
        if (match.kind !== 'match') throw new Error(text('成员不明确或不可用，请指定完整标识：', 'Member is ambiguous or unavailable; use a full slug: ') + member.expertSlug + '\n' + JSON.stringify(match.candidates.map(expert => ({ slug: expert.slug, name: expert.name, nameEn: expert.nameEn }))))
        return { ...member, expertSlug: match.slug }
      })
      exec.signal.throwIfAborted()
      const proposal = drafts.save(id, { kind: 'team', data: { ...args, members, coordinatorMode: args.coordinatorPrompt?.trim() ? 'custom' : 'template', coordinatorTemplateVersion: 1, coordinatorPrompt: args.coordinatorPrompt ?? '' } })
      return { proposalId: proposal.id, markdown: renderDraft(proposal.draft, locale(), catalog.experts), ready: false }
    },
  })))
  for (const kind of ['expert', 'team'] as const) ctx.effect(() => ctx.tools.register(defineTool({
    name: kind === 'expert' ? 'open_custom_expert_editor' : 'open_expert_team_editor',
    description: 'Request human confirmation of the exact reviewed proposalId and make the prefilled personal editor available. Only call after explicit user confirmation. Final Save is still required; this never publishes company content.',
    parameters: { proposalId: { type: 'string', required: true } }, output,
    async execute(args, exec) {
      const id = session(exec), draft = drafts.get(id, args.proposalId)
      if (!draft || draft.kind !== kind) throw new Error(text('草案已过期或已修改，请重新生成预览', 'The draft expired or changed. Generate a new preview.'))
      const questions = ctx.get('userQuestions')
      if (!questions) throw new Error(text('确认服务不可用，请稍后重试', 'Confirmation is unavailable. Try again later.'))
      const approve = text('打开编辑器', 'Open editor')
      const answer = await questions.ask({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'open-creation-editor', question: text('打开草案编辑器进行最终核对？', 'Open this draft for final review?'), detail: renderDraft(draft, locale(), (await library.catalog()).experts), options: [{ label: approve }, { label: text('继续修改', 'Keep editing') }] }] })
      exec.signal.throwIfAborted()
      const accepted = answer.answers.find(item => item.id === 'open-creation-editor')
      if (accepted?.custom || accepted?.selected.length !== 1 || accepted.selected[0] !== approve) return { proposalId: args.proposalId, markdown: text('草案未保存，可以继续修改', 'Draft not saved. You can keep editing.'), ready: false }
      if (!drafts.confirm(id, args.proposalId)) throw new Error(text('草案已过期或已修改，请重新生成预览', 'The draft expired or changed. Generate a new preview.'))
      return { proposalId: args.proposalId, markdown: text('草案已确认。打开编辑器核对后点击保存；尚未保存或发布。', 'Draft confirmed. Open the editor, review it and click Save. Nothing has been saved or published yet.'), ready: true }
    },
  })))
}
