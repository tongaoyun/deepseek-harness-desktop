/** Native-typed Agent Teams doubles used by expert dispatch tests. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TeamId, TeamTaskId, type TeamMemberView, type TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { onTestFinished, vi } from 'vitest'
import type { NativeTeamService } from '../src/team-engine.ts'

/** Create a structural Agent with native identity, Session and scoped lifecycle. */
export function createTeamAgent(ctx = new Context()): Agent {
  onTestFinished(() => ctx.fiber.dispose())
  const id = SessionId(randomUUID())
  return { id, ctx, options: {}, session: Session.create(id), status: 'idle',
    inbox: { nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [] },
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
}

/** Build one complete native roster row, including its durable identity. */
export function nativeTeamMember(name: string, status: TeamMemberView['status'] = 'running'): TeamMemberView {
  return { id: SessionId(name), name, role: 'teammate', status, diagnostics: [] }
}

function task(): TeamTaskView {
  return { id: TeamTaskId('1'), revision: 1, subject: 'Review', description: 'Review the task',
    status: 'pending', blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }
}

/** Exercise current native method signatures and statuses without starting model work. */
export function createNativeTeam() {
  const members: TeamMemberView[] = []
  const service = {
    tryMembership: vi.fn<NativeTeamService['tryMembership']>(agent => ({ root: agent, id: TeamId(agent.id), role: 'lead', name: 'lead' })),
    listMembers: vi.fn<NativeTeamService['listMembers']>(() => members),
    spawnTeammate: vi.fn<NativeTeamService['spawnTeammate']>(async (_agent, request) => {
      const member = nativeTeamMember(request.name)
      members.push(member)
      return { member }
    }),
    sendMessage: vi.fn<NativeTeamService['sendMessage']>(async () => ({ messageId: MessageId('native-message') })),
    createTask: vi.fn<NativeTeamService['createTask']>(async () => task()),
    updateTask: vi.fn<NativeTeamService['updateTask']>(async () => ({ ...task(), revision: 2, status: 'deleted' })),
    interrupt: vi.fn<NativeTeamService['interrupt']>(() => ({ previousStatus: 'running' })),
  } satisfies NativeTeamService
  return { service, members }
}
