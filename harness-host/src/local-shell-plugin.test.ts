import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCommand } from './local-shell-plugin.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('local shell', () => {
  it('runs in the selected directory without inheriting application secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'xiaoyin-shell-'))
    temporaryDirectories.push(directory)
    process.env.XIAOYIN_TEST_SECRET = 'must-not-leak'
    const command = process.platform === 'win32'
      ? '$v=$env:XIAOYIN_TEST_SECRET; if ($null -eq $v) {$v="unset"}; Write-Output (Get-Location).Path; Write-Output $v'
      : 'pwd; printf "\\n%s\\n" "${XIAOYIN_TEST_SECRET-unset}"'
    try {
      const result = await runCommand(command, directory, 10_000, new AbortController().signal) as { exitCode: number; stdout: string }
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(directory)
      expect(result.stdout).toContain('unset')
      expect(result.stdout).not.toContain('must-not-leak')
    } finally {
      delete process.env.XIAOYIN_TEST_SECRET
    }
  })
})
