import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const host = fileURLToPath(new URL('../harness-host/', import.meta.url))
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const stages = [
  { name: 'build-host', command: pnpm, args: ['--dir', 'harness-host', 'build'], cwd: root, timeout: 120_000 },
  { name: 'knowledge-enabled-host-startup', command: process.execPath,
    args: ['harness-host/scripts/acceptance-knowledge-startup.mjs'], cwd: root, timeout: 60_000 },
  { name: 'desktop-knowledge-notice-im', command: pnpm, args: ['exec', 'vitest', 'run',
    'src/App.queue.test.tsx', 'src/capabilitySnapshot.test.ts', 'src/useHarnessNotifications.test.tsx',
    'src/taskPersistence.test.ts', 'src/conversation/liveText.test.ts', 'src/useLocalImSync.test.tsx', 'src/imTaskSync.test.ts',
    'src/chat/ApprovalQuestion.test.tsx'], cwd: root, timeout: 120_000 },
  { name: 'host-connector-knowledge-approval-im', command: pnpm, args: ['exec', 'vitest', 'run',
    'src/managed-mcp-plugin.test.ts', 'src/knowledge-plugin.test.ts', 'src/approval-bridge.test.ts',
    'src/im-runtime.test.ts', 'src/im-delivery.test.ts'], cwd: host, timeout: 120_000 },
  { name: 'native-immediate-notice', command: 'cargo', args: ['test', '--manifest-path', 'src-tauri/Cargo.toml',
    'local_store::tests::capability_notice_is_appended_without_replacing_task_state_or_crossing_sessions'], cwd: root, timeout: 180_000 },
  { name: 'host-restart-and-capability-gap', command: process.execPath,
    args: ['harness-host/scripts/acceptance-session-continuity.mjs'], cwd: root, timeout: 90_000 },
  { name: 'approval-before-skill-write', command: process.execPath,
    args: ['harness-host/scripts/acceptance-skill-tools.mjs'], cwd: root, timeout: 90_000 },
]

for (const stage of stages) {
  console.log(JSON.stringify({ stage: stage.name, status: 'running' }))
  await new Promise((resolve, reject) => {
    const child = spawn(stage.command, stage.args, { cwd: stage.cwd, stdio: 'inherit' })
    const timer = setTimeout(() => child.kill('SIGTERM'), stage.timeout)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${stage.name} failed (${signal ?? code})`))
    })
  })
  console.log(JSON.stringify({ stage: stage.name, status: 'passed' }))
}

console.log(JSON.stringify({ suite: 'work-buddy-fixture', passed: true, realModel: false, realDingTalk: false,
  liveFollowUp: ['knowledge-access-revocation', 'connector-recovery', 'write-approval', 'im-delivery'] }))
