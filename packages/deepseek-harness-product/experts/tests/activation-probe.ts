/** 子 Agent 创建事件探针：检查人格与工具限制通过当前宿主注册点生效。 */
export function createActivationProbe() {
  type Event = { agent: {
    id: string
    ctx: {
      systemPrompt: { section(value: { text: string }): void; getSectionOrder(name: string): number }
      tools: { restrict(value: { deny: string[] }): void }
    } } }
  const listeners = new Set<(event: Event) => void>()
  const sections: { text: string }[] = []
  const restrictions: { deny: string[] }[] = []
  return {
    sections, restrictions,
    on(name: string, listener: (event: Event) => void) {
      if (name === 'agent/created') listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    create(spec: { childId: string }) {
      const event = { agent: { id: spec.childId, ctx: { systemPrompt: {
        section(value: { text: string }) { sections.push(value) }, getSectionOrder() { return 0 },
      }, tools: { restrict(value: { deny: string[] }) { restrictions.push(value) } } } } }
      for (const listener of listeners) listener(event)
    },
    get listening() { return listeners.size },
  }
}
