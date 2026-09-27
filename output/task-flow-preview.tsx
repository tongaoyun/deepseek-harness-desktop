import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ChatPage } from '../src/ChatPage'
import type { XiaoyinTaskProjection } from '../src/types'
import '../src/styles.css'

const noop = () => {}
function Preview() {
  const [running, setRunning] = useState(true)
  const [prompt, setPrompt] = useState('补充适用场景和引用来源')
  const [queue, setQueue] = useState({ paused: false, items: [{ id: 'q1', text: '将关键差异整理成中文摘要' }, { id: 'q2', text: '再检查一次表格中是否有缺失项' }] })
  const now = new Date().toISOString()
  const projection: XiaoyinTaskProjection = {
    executionStarted: running,
    status: running ? 'running' : 'completed', activity: running ? '正在整理对比表格' : '任务已完成', startedAt: new Date(Date.now() - 83000).toISOString(), updatedAt: now,
    completedAt: running ? undefined : now, steps: [],
    timeline: [
      { id: 'note', kind: 'assistant', label: '进度说明', text: '已读取产品资料，接下来整理功能差异并检查表格。', status: 'completed', occurredAt: now },
      { id: 'search', kind: 'browser', label: '检索产品官方资料', detail: '测试样例：三个来源', status: 'completed', occurredAt: now },
      { id: 'read', kind: 'file', label: '读取参考资料', detail: '测试样例：参考资料.md', status: 'completed', occurredAt: now },
      { id: 'note2', kind: 'assistant', label: '进度说明', text: '资料已整理完毕，正在生成文件并核对内容。', status: 'completed', occurredAt: now },
      { id: 'write', kind: 'tool', label: '生成并检查表格', toolName: 'spreadsheet', status: running ? 'running' : 'completed', occurredAt: now },
    ],
    artifacts: running ? [] : [{ id: 'result', name: 'AI助手对比.xlsx', path: 'AI助手对比.xlsx', rootId: 'fixture', rootName: '测试样例（无实际文件）', kind: 'spreadsheet', sourceTool: 'spreadsheet', sizeBytes: 16240, createdAt: now }],
  }
  return <><header style={{ padding: '10px 24px', background: '#f3f4f5', fontSize: 12 }}>界面测试样例，非真实模型执行或生成文件。 <button onClick={() => { setRunning(!running); setQueue({ ...queue, paused: running }) }}>切换{running ? '结束' : '运行'}状态</button></header><main className="workspace">
    <ChatPage activeModel="测试模型" composerRef={useRef(null)} messageListRef={useRef(null)} modelPickerRef={useRef(null)}
      messages={[{ role: 'user', text: '调研 AI 桌面助手的功能，整理成对比表格。' }, { role: 'assistant', text: running ? '' : '对比表格已整理完毕，包含功能、适用场景和引用来源。', pending: running, projection }]}
      taskProjection={projection} prompt={prompt} queue={queue} onPrompt={setPrompt} currentTaskRunning={running} harnessRunning={running} harnessHealth="ready" harnessHealthDetail="" runtimeStatus="ready"
      onSubmit={(event) => { event.preventDefault(); if (prompt.trim()) { setQueue({ ...queue, items: [...queue.items, { id: crypto.randomUUID(), text: prompt }] }); setPrompt('') } }}
      onCancel={() => { setRunning(false); setQueue({ ...queue, paused: true }) }} onPauseQueue={() => setQueue({ ...queue, paused: true })} onResumeQueue={() => setQueue({ ...queue, paused: false })}
      onEditQueued={(id, text) => setQueue({ ...queue, items: queue.items.map((item) => item.id === id ? { ...item, text } : item) })} onRemoveQueued={(id) => setQueue({ ...queue, items: queue.items.filter((item) => item.id !== id) })}
      models={[]} modelMenuOpen={false} knowledgeBases={[]} selectedKnowledgeBaseRefs={[]} localDirectories={[]} pendingAttachments={[]} localFileError=""
      onAddKnowledge={noop} onAddLocalDirectory={noop} onAddLocalFiles={noop} onPrepareRetry={noop} onReconnect={noop} onRecoverHarness={noop} onRemoveAttachment={noop} onRemoveKnowledge={noop} onRemoveLocalDirectory={noop} onSelectModel={noop} onToggleModelMenu={noop} />
    </main></>
}
createRoot(document.getElementById('root')!).render(<Preview />)
