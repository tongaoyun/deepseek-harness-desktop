import { DesktopToolBridge } from './desktop-tool-bridge.js'
import type { JsonRpcOutput } from './protocol.js'

export class ScheduleBridge extends DesktopToolBridge {
  constructor(emit: (value: JsonRpcOutput) => void) {
    super(emit, 'schedule', ['list', 'create', 'update', 'pause', 'resume', 'delete'], 15000)
  }
}
