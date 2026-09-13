// Development-only fixture using real conversation components, not production data.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatPage, type ChatPageProps } from '../src/ChatPage'
import type { XiaoyinTaskProjection } from '../src/types'
import '../src/styles.css'

const noop = () => {}
const taskProjection: XiaoyinTaskProjection = { status: 'completed', activity: '', updatedAt: '', steps: [], artifacts: [] }
const messages = Array.from({ length: 2000 }, (_, index) => ({ role: 'assistant' as const, text: `### 合成消息 ${index}\n\n这是用于长会话切换验收的合成内容，不读取业务资料。\n\n- 文件处理完成\n- 数量核对通过\n\n\`\`\`ts\nconst total = ${index};\n\`\`\`` }))
const base: ChatPageProps = {
  activeModel: '验收模型（不调用）', composerRef: { current: null }, harnessHealth: 'ready', harnessHealthDetail: '', harnessRunning: false,
  knowledgeBases: [], localDirectories: [], localFileError: '', messageListRef: { current: null }, messages,
  modelMenuOpen: false, modelPickerRef: { current: null }, models: [], pendingAttachments: [],
  onAddKnowledge: noop, onAddLocalDirectory: noop, onAddLocalFiles: noop, onCancel: noop, onPrepareRetry: noop,
  onPrompt: noop, onReconnect: noop, onRecoverHarness: noop, onRemoveAttachment: noop, onRemoveKnowledge: noop,
  onRemoveLocalDirectory: noop, onSelectModel: noop, onSubmit: (event) => event.preventDefault(), onToggleModelMenu: noop,
  prompt: '', runtimeStatus: 'ready', selectedKnowledgeBaseRefs: [], taskProjection,
}
function Fixture() {
  const [id, setId] = useState(0)
  const [result, setResult] = useState('2000 条合成消息，等待验收')
  const [busy, setBusy] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  async function run() {
    if (busy) return
    setBusy(true)
    const times: number[] = []
    let maxTurns = 0, maxNodes = 0, maxBottomGap = 0
    for (let index = 1; index <= 100; index++) {
      const start = performance.now()
      flushSync(() => setId(index))
      times.push(performance.now() - start)
      await new Promise(requestAnimationFrame)
      maxTurns = Math.max(maxTurns, document.querySelectorAll('.conversation-turn').length)
      maxNodes = Math.max(maxNodes, document.querySelectorAll('*').length)
      if (list.current) maxBottomGap = Math.max(maxBottomGap, list.current.scrollHeight - list.current.scrollTop - list.current.clientHeight)
    }
    times.sort((a, b) => a - b)
    setResult(JSON.stringify({ switches: 100, messages: messages.length, maxTurns, maxNodes, maxBottomGap, p50Ms: +times[49].toFixed(2), p95Ms: +times[94].toFixed(2), documentOverflow: document.documentElement.scrollHeight - innerHeight }))
    setBusy(false)
  }
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}><header style={{ flexShrink: 0, padding: 8, display: 'flex', gap: 12 }}><button disabled={busy} onClick={() => void run()}>连续切换 100 次</button><output aria-live="polite">{busy ? `正在切换 ${id}/100` : result}</output></header><main className="workspace" style={{ flex: 1 }}><ChatPage {...base} taskId={`fixture-${id}`} messageListRef={list} /></main></div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
