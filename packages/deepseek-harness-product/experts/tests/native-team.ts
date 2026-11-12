/** Native-typed Agent Teams doubles used by expert dispatch tests. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamTaskId, type TeamTaskView } from '@deepseek-ai/dsh-agent-team'
import type SubagentService from '@deepseek-ai/dsh-subagent'
import type { SubagentDescendantListEntry, SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { onTestFinished, vi } from 'vitest'
import type { NativeTeamService } from '../src/team-engine.ts'

/** Create a structural Agent with native identity, Session and scoped lifecycle. */
export function createTeamAgent(ctx = new Context()): Agent {
  onTestFinished(() => ctx.fiber.dispose())
  const id = SessionId(randomUUID())
  return { id, ctx, options: {}, model: { current: () => undefined, select() {} }, session: Session.create(id), status: 'idle',
    inbox: { nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [] },
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
}

/** Build one native catalog row with its parent-owned identity. */
export function nativeTeamMember(name: string, parentId: SessionId, activity: 'running' | 'inactive' = 'running'): Extract<SubagentDescendantListEntry, { kind: 'child'; mode: 'continuable' }> {
  return { kind: 'child', id: SessionId(name), name, parentId, activity, depth: 1, mode: 'continuable', label: name, hasChildren: false }
}

function task(): TeamTaskView {
  return { id: TeamTaskId('1'), revision: 1, subject: 'Review', description: 'Review the task',
    status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }
}

/** Exercise current native method signatures and statuses without starting model work. */
export function createNativeTeam() {
  const members: SubagentDescendantListEntry[] = []
  const subagents = {
    namesOf: vi.fn<SubagentService['namesOf']>(() => ({ self: 'lead' })),
    listDescendants: vi.fn<SubagentService['listDescendants']>(async () => members),
    startActivation: vi.fn(async (request: SubagentActivationSpec) => {
      const name = request.name ?? 'agent-1'
      const member = nativeTeamMember(name, request.parent.id)
      members.push(member)
      return { childId: member.id, name, messageId: MessageId('native-message'),
        result: Promise.resolve({ stopReason: 'completed' as const, output: [] }), dispose: async () => {} }
    }),
    sendMessage: vi.fn<SubagentService['sendMessage']>(async () => MessageId('native-message')),
    interrupt: vi.fn<SubagentService['interrupt']>(() => {}),
  } satisfies Pick<SubagentService, 'namesOf' | 'listDescendants' | 'startActivation' | 'sendMessage' | 'interrupt'>
  const service = {
    isEnabled: vi.fn<NativeTeamService['isEnabled']>(() => true),
    createTask: vi.fn<NativeTeamService['createTask']>(async () => task()),
    updateTask: vi.fn<NativeTeamService['updateTask']>(async () => ({ ...task(), revision: 2, status: 'deleted' })),
  } satisfies NativeTeamService
  return { service, subagents, members }
}
