import { execFileSync } from 'node:child_process'
import { copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

copyFileSync(new URL('../src/pptx-render-worker.mjs', import.meta.url), new URL('../dist/pptx-render-worker.mjs', import.meta.url))

if (process.platform === 'darwin') {
  const source = fileURLToPath(new URL('../native/computer-use.swift', import.meta.url))
  const requested = process.env.XIAOYIN_MACOS_ARCH
  const arch = requested === 'x64' || requested === 'x86_64' ? 'x86_64' : requested === 'arm64' || requested === 'aarch64' ? 'arm64' : undefined
  if (requested && !arch) throw new Error(`Unsupported macOS target architecture: ${requested}`)
  const output = fileURLToPath(new URL(`../native/xiaoyin-computer-use${arch ? `-${arch}` : ''}`, import.meta.url))
  execFileSync('xcrun', ['swiftc', '-parse-as-library', '-O', ...(arch ? ['-target', `${arch}-apple-macos14.0`] : []), source, '-o', output], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'cn.xiaoyin.computer-use', output], { stdio: 'inherit' })
}
