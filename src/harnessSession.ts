import { draftRootPaths, type TaskDraft } from './taskDrafts'
import type { LocalTaskRun } from './types'

export function restoredTaskSessionId(task: LocalTaskRun, draft?: TaskDraft): string {
  if (!draft) return task.sessionId ?? ''
  const savedRoots = (task.localDirectories ?? []).flatMap((directory) => directory.path ? [directory.path] : [])
  return JSON.stringify(draftRootPaths(draft).sort()) === JSON.stringify(savedRoots.sort()) ? task.sessionId ?? '' : ''
}

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
