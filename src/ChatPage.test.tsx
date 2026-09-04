import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPage } from './ChatPage'
import type { TaskMonitorState } from './types'

describe('ChatPage conversation', () => {
  it('restores the new-task welcome copy', () => {
    const monitor: TaskMonitorState = {
      status: 'idle', activity: '', updatedAt: '2026-09-03T10:00:00.000Z', steps: [], artifacts: [],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" capabilityOptions={[]} composerRef={{ current: null }} harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning={false} knowledgeBases={[]} localDirectories={[]}
      localFileError="" messageListRef={{ current: null }} pendingAttachments={[]} messages={[]}
      modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onCancel={() => undefined} onSelectCapability={() => undefined}
      onPrepareRetry={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined}
      onSelectInvocation={() => undefined} onSelectModel={() => undefined} onSubmit={() => undefined}
      onToggleModelMenu={() => undefined} prompt="" runtimeStatus="ready" selectedCapabilityId=""
      selectedCapabilityName="通用" selectedKnowledgeBaseRefs={[]} taskMonitor={monitor}
      visibleInvocations={[]} visibleKnowledgeContexts={[]}
    />)
    expect(html).toContain('不止聊天，搞定一切')
    expect(html).toContain('本地运行、自主规划、安全可控的 AI 工作搭子')
  })

  it('renders work as full-width turns without assistant chat bubbles', () => {
    const monitor: TaskMonitorState = {
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:00:02.000Z', updatedAt: '2026-09-03T10:00:02.000Z', steps: [], artifacts: [],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" capabilityOptions={[]} composerRef={{ current: null }} creationKind="expert-kit" harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning={false} knowledgeBases={[]} localDirectories={[]}
      localFileError="" messageListRef={{ current: null }} pendingAttachments={[]} messages={[
        { role: 'user', text: '解释冒泡排序' },
        { role: 'assistant', text: '冒泡排序会比较相邻元素。', monitor },
      ]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onCancel={() => undefined} onContinueCreation={() => undefined} onSelectCapability={() => undefined}
      onPrepareRetry={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined} onSelectInvocation={() => undefined}
      onSelectModel={() => undefined} onSubmit={() => undefined} onToggleModelMenu={() => undefined} prompt=""
      runtimeStatus="ready" selectedCapabilityId="" selectedCapabilityName="通用" selectedKnowledgeBaseRefs={[]}
      taskMonitor={monitor} visibleInvocations={[]} visibleKnowledgeContexts={[]}
    />)

    expect(html).toContain('conversation-turn user-turn')
    expect(html).toContain('conversation-turn assistant-turn')
    expect(html).toContain('用时 2秒')
    expect(html).not.toContain('message-avatar')
    expect(html).not.toContain('>小胤<')
    expect(html).toContain('添加')
    expect(html).toContain('保存为专家套件')
  })

  it('shows streamed assistant text and local attachments before completion', () => {
    const monitor: TaskMonitorState = {
      status: 'running', activity: '正在处理', startedAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:01.000Z', steps: [], artifacts: [],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" capabilityOptions={[]} composerRef={{ current: null }} harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning knowledgeBases={[]}
      localDirectories={[]} localFileError="" messageListRef={{ current: null }} messages={[
        { role: 'assistant', text: '正在列出下载目录中的文件', pending: true, monitor },
      ]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onCancel={() => undefined} onSelectCapability={() => undefined}
      onPrepareRetry={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined}
      onSelectInvocation={() => undefined} onSelectModel={() => undefined} onSubmit={() => undefined}
      onToggleModelMenu={() => undefined} pendingAttachments={[{
        id: 'download:image.png', rootId: 'download', rootName: '下载', path: 'image.png', name: 'image.png', kind: 'image', mediaType: 'image/png',
      }]} prompt="" runtimeStatus="ready" selectedCapabilityId="" selectedCapabilityName="通用"
      selectedKnowledgeBaseRefs={[]} taskMonitor={monitor} visibleInvocations={[]} visibleKnowledgeContexts={[]}
    />)

    expect(html).toContain('正在列出下载目录中的文件')
    expect(html).toContain('streaming-response')
    expect(html).toContain('image.png')
    expect(html).not.toContain('disabled="" title="发送"')
  })
})
