/** Product-owned modules are fixed Desktop profile contributions, not installable extensions. */
export function builtinCapabilityPatches() {
  return [{ defaults: true, insert: [
    { id: 'agent-team', name: import.meta.resolve('@deepseek-ai/dsh-experimental-agent-team') },
    { id: 'tool-agent-team', name: import.meta.resolve('@deepseek-ai/dsh-experimental-tool-agent-team') },
    { id: 'ui-agent-team', name: import.meta.resolve('@deepseek-ai/dsh-experimental-client-ui-agent-team') },
    { id: 'agency-agents-remote', name: import.meta.resolve('@deepseek-harness/product-experts/remote') },
    { id: 'agency-agents', name: import.meta.resolve('@deepseek-harness/product-experts') },
    { id: 'skills-manager', name: import.meta.resolve('@deepseek-harness/product-skills') },
  ] }]
}
