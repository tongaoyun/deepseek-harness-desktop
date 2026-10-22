/** Product-owned modules are fixed Desktop profile contributions, not installable extensions. */
export function builtinCapabilityPatches() {
  return [{ defaults: true, insert: [
    { id: 'agency-agents-remote', name: import.meta.resolve('@deepseek-harness/product-experts/remote') },
    { id: 'agency-agents', name: import.meta.resolve('@deepseek-harness/product-experts') },
    { id: 'skills-manager', name: import.meta.resolve('@deepseek-harness/product-skills') },
  ] }]
}
