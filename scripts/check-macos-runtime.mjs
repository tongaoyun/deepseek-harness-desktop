import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const [host, architecture] = process.argv.slice(2)
assert.ok(host && ['arm64', 'x64'].includes(architecture), 'Expected staged Harness path and target architecture')
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, architecture, 'Embedded Node architecture does not match the target')
const require = createRequire(resolve(host, 'package.json'))
require('koffi')
const { createCanvas } = require('@napi-rs/canvas')
assert.ok(createCanvas(2, 2).toBuffer('image/png').length > 0, 'PDF/image native dependency failed')
const helper = resolve(host, 'native/xiaoyin-computer-use')
const binaryArch = architecture === 'x64' ? 'x86_64' : 'arm64'
assert.ok(execFileSync('/usr/bin/lipo', ['-archs', helper], { encoding: 'utf8' }).trim().split(/\s+/).includes(binaryArch), 'Computer Use helper architecture mismatch')
const { spawn } = require('node-pty')
await new Promise((done, fail) => {
  const terminal = spawn('/usr/bin/true', [], { name: 'xterm', cols: 80, rows: 24, cwd: host, env: { PATH: '/usr/bin:/bin' } })
  const timer = setTimeout(() => { terminal.kill(); fail(new Error('Native terminal smoke test timed out')) }, 10_000)
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer)
    if (exitCode === 0) done()
    else fail(new Error(`Native terminal exited ${exitCode}`))
  })
})
console.log(`Embedded ${architecture} Node, terminal, FFI, PDF/image and Computer Use architectures verified`)
