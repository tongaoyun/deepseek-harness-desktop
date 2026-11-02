// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { installNativeTeamNames } from './native-team-names.ts'

const architectId = 'agency-engineering-software-architect-8a70fbbcd3'
const securityId = 'agency-security-appsec-engineer-f29ea176a0'

function rosterMember(name: string): Text {
  const roster = document.createElement('div')
  roster.className = 'native_roster'
  roster.innerHTML = '<button><span class="native_memberText"><span class="native_memberName"><span class="native_memberNameText"></span></span></span></button>'
  const node = document.createTextNode(name)
  roster.querySelector('.native_memberNameText')!.append(node)
  document.body.append(roster)
  return node
}

afterEach(() => { document.body.replaceChildren() })

describe('installNativeTeamNames', () => {
  it('localizes known member names, preserves lead, and leaves Host replacements intact on disposal', async () => {
    const lead = rosterMember('lead')
    const member = rosterMember(architectId)
    const loader = vi.fn(async () => ({ members: new Map([[architectId, '软件架构师']]), teams: [] }))
    const onError = vi.fn()
    const handle = installNativeTeamNames(loader, onError)
    try {
      await handle.refresh()
      expect(member.data).toBe('软件架构师')
      expect(lead.data).toBe('lead')
      member.data = '产品经理'
    } finally { handle.dispose() }
    expect(member.data).toBe('产品经理')
    expect(lead.data).toBe('lead')
    expect(onError).not.toHaveBeenCalled()
  })

  it('localizes lead for a matching team title and restores the original text on disposal', async () => {
    const lead = rosterMember('lead')
    const title = document.createElement('div')
    title.className = 'native_taskTitle'
    title.innerHTML = '<strong>技术方案评审团: 软件架构师</strong>'
    document.body.append(title)
    const loader = vi.fn(async () => ({ members: new Map<string, string>(), teams: [{ names: ['技术方案评审团'], label: '技术方案评审团' }] }))
    const handle = installNativeTeamNames(loader, vi.fn())
    try {
      await handle.refresh()
      expect(lead.data).toBe('技术方案评审团')
    } finally { handle.dispose() }
    expect(lead.data).toBe('lead')
  })

  it('leaves task owner routing identifiers unchanged', async () => {
    const tasks = document.createElement('div')
    tasks.innerHTML = `<div class="native_tasks"><div class="native_task"><div class="native_meta"><span>task-1</span><span>Owner: ${securityId}</span></div></div></div>`
    document.body.append(tasks)
    const loader = vi.fn(async () => ({ members: new Map([[securityId, '应用安全工程师']]), teams: [] }))
    const handle = installNativeTeamNames(loader, vi.fn())
    try {
      await handle.refresh()
      expect(tasks.textContent).toBe(`task-1Owner: ${securityId}`)
    } finally { handle.dispose() }
    expect(tasks.textContent).toBe(`task-1Owner: ${securityId}`)
  })
})
