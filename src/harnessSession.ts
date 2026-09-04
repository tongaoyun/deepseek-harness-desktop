export function resolveHarnessSessionId(
  currentSessionId: string,
  persistedSessionId: string | undefined,
  runtimeCapabilitiesChanged: boolean,
  createSessionId: () => string,
): string {
  // Harness sessions are bound to the workspace and tool catalog they started with.
  // Adding a local directory changes both, so resuming the old session is invalid.
  if (runtimeCapabilitiesChanged) return createSessionId()
  return currentSessionId || persistedSessionId || createSessionId()
}
