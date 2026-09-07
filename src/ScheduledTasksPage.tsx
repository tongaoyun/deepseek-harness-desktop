import { LocalSchedulesPanel } from './LocalSchedulesPanel'
import type { LocalSchedulesController } from './useLocalSchedules'

export function ScheduledTasksPage({ local, onOpenLocalTask, onCreateWithXiaoyin, models }: {
  models?: string[]
  local: LocalSchedulesController
  onOpenLocalTask: (id: string) => void
  onCreateWithXiaoyin: () => void
}) {
  return <div className="schedule-page schedule-reference"><LocalSchedulesPanel controller={local} onOpenTask={onOpenLocalTask} onCreateWithXiaoyin={onCreateWithXiaoyin} models={models} /></div>
}
