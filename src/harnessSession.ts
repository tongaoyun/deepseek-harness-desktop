export function resolveHarnessSessionId(
  currentSessionId: string,
  persistedSessionId: string | undefined,
  mustStartFreshSession: boolean,
  createSessionId: () => string,
): string {
  // Harness sessions are bound to the workspace and tool catalog they started with.
  // Capability changes and failed turns can leave a persisted session unsafe to resume.
  if (mustStartFreshSession) return createSessionId()
  return currentSessionId || persistedSessionId || createSessionId()
}
