/** Windows acceptance process ownership uses creation time as well as reusable process identifiers. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** @returns {Promise<Array>} Current processes, with exact UTC creation ticks and executable paths. */
export async function windowsProcessSnapshot() {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance Win32_Process | ForEach-Object {
  @{ pid = $_.ProcessId; parent = $_.ParentProcessId; command = $_.CommandLine; image = $_.ExecutablePath;
     started = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' }) }
})
ConvertTo-Json -Compress -InputObject $rows
`], { timeout: 20_000, windowsHide: true })
  return JSON.parse(stdout)
}

function creation(process) {
  if (!/^\d+$/u.test(process.started ?? '')) throw new Error(`Process ${process.pid} has no creation time`)
  return BigInt(process.started)
}

/** @param {Array} processes One process snapshot. @param {number} parent Root PID. @returns {Array} Descendants created during their actual parent's lifetime; stale parent identifiers are excluded. */
export function windowsProcessDescendants(processes, parent) {
  const root = processes.find(process => process.pid === parent)
  if (!root) throw new Error(`Acceptance process ${parent} exited before its ownership snapshot`)
  creation(root)
  const pending = [root]
  const seen = new Set([root.pid])
  const children = []
  for (const owner of pending) for (const process of processes) {
    if (process.parent !== owner.pid || seen.has(process.pid)) continue
    if (creation(process) < creation(owner)) continue
    seen.add(process.pid)
    children.push(process)
    pending.push(process)
  }
  return children
}

/** @param {Array} processes Current snapshot. @param {Array} originals Captured process identities. @returns {Array} Originals still alive; a different process reusing a PID is never an original. */
export function originalWindowsProcesses(processes, originals) {
  const current = new Map(processes.map(process => [process.pid, process]))
  return originals.flatMap(original => {
    creation(original)
    const process = current.get(original.pid)
    return process && creation(process) === creation(original) ? [process] : []
  })
}
