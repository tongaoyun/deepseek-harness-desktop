import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPage } from './ChatPage'
import type { TaskMonitorState } from './types'

describe('ChatPage conversation', () => {
  it('renders work as full-width turns without assistant chat bubbles', () => {
    const monitor: TaskMonitorState = {
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:00:02.000Z', updatedAt: '2026-09-03T10:00:02.000Z', steps: [], artifacts: [],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" capabilityOptions={[]} composerRef={{ current: null }} harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning={false} knowledgeBases={[]} localDirectories={[]}
      localFileError="" messageListRef={{ current: null }} messages={[
        { role: 'user', text: '解释冒泡排序' },
        { role: 'assistant', text: '冒泡排序会比较相邻元素。', monitor },
      ]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onCancel={() => undefined} onSelectCapability={() => undefined}
      onPrepareRetry={() => undefined} onPrompt={() => undefined} onRecoverHarness={() => undefined}
      onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined} onSelectInvocation={() => undefined}
      onSelectModel={() => undefined} onSubmit={() => undefined} onToggleModelMenu={() => undefined} prompt=""
      runtimeStatus="ready" selectedCapabilityExecutable selectedCapabilityId="" selectedCapabilityName="通用" selectedKnowledgeBaseRefs={[]}
      taskMonitor={monitor} visibleInvocations={[]} visibleKnowledgeContexts={[]}
    />)

    expect(html).toContain('conversation-turn user-turn')
    expect(html).toContain('conversation-turn assistant-turn')
    expect(html).toContain('已处理 2秒')
    expect(html).not.toContain('message-avatar')
    expect(html).not.toContain('>小胤<')
    expect(html).toContain('添加')
  })
})
