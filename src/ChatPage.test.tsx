import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatPage } from './ChatPage'
import { assistantEntry, userEntry } from './conversation/testing'
import type { TaskArtifact, XiaoyinTaskProjection } from './types'

const artifact: TaskArtifact = {
  id: 'sales', rootId: 'workspace', rootName: '工作目录', path: 'sales.xlsx', name: 'sales.xlsx',
  kind: 'spreadsheet', sourceTool: 'office_xlsx_create', action: 'created', createdAt: '2026-09-03T10:00:01.000Z',
}

describe('ChatPage conversation', () => {
  it('restores the new-task welcome copy', () => {
    const projection: XiaoyinTaskProjection = {
      status: 'idle', activity: '', updatedAt: '2026-09-03T10:00:00.000Z', steps: [], artifacts: [],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" composerRef={{ current: null }} harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning={false} knowledgeBases={[]} localDirectories={[]}
      localFileError="" messageListRef={{ current: null }} pendingAttachments={[]} entries={[]}
      modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onAddLocalFiles={() => undefined} onCancel={() => undefined}
      onEditTurn={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined}
      onSelectModel={() => undefined} onSubmit={() => undefined}
      onToggleModelMenu={() => undefined} prompt="" runtimeStatus="ready"
      selectedKnowledgeBaseRefs={[]} taskProjection={projection}
    />)
    expect(html).toContain('不止聊天，搞定一切')
    expect(html).toContain('本地运行、自主规划、安全可控的 AI 工作搭子')
    expect(html).toContain('placeholder="描述任务，/ 调用技能或套件，@ 添加上下文"')
    expect(html).toContain('aria-label="添加上下文"')
    expect(html).toContain('aria-label="执行模式"')
    expect(html).toContain('aria-pressed="true" title="执行任务"')
    expect(html).toContain('title="只研究并提交计划"')
    expect(html).not.toContain('agent-mode')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('自主规划并执行，自动加载技能和连接器')
    expect(html).not.toContain('@ 引用知识库')
    expect(html).not.toContain('快捷指令')
    expect(html).not.toContain('>通用<')
  })

  it('renders work as full-width turns without assistant chat bubbles', () => {
    const projection: XiaoyinTaskProjection = {
      status: 'completed', activity: '任务已完成', startedAt: '2026-09-03T10:00:00.000Z',
      completedAt: '2026-09-03T10:00:02.000Z', updatedAt: '2026-09-03T10:00:02.000Z', steps: [], artifacts: [artifact],
      changes: [{ ...artifact, action: 'created', changedAt: artifact.createdAt }],
      knowledgeSources: [{ sourceId: '12', knowledgeBaseId: 'kb', knowledgeBaseName: '知识', documentId: 'doc', filename: '排序说明.md', locator: '正文', content: '原文', score: 1 }],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" composerRef={{ current: null }} creationKind="skill" harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning={false} knowledgeBases={[]} localDirectories={[]}
      localFileError="" messageListRef={{ current: null }} pendingAttachments={[]} entries={[
        userEntry('u1', '解释冒泡排序'),
        assistantEntry('turn:1', '冒泡排序会比较相邻元素。', { outcome: projection.outcome }),
      ]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onAddLocalFiles={() => undefined} onCancel={() => undefined} onContinueCreation={() => undefined}
      onEditTurn={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined}
      onSelectModel={() => undefined} onSubmit={() => undefined} onToggleModelMenu={() => undefined} prompt=""
      runtimeStatus="ready" selectedKnowledgeBaseRefs={[]}
      taskProjection={projection}
    />)

    expect(html).toContain('conversation-turn user-turn')
    expect(html).toContain('conversation-turn assistant-turn')
    expect(html).not.toContain('inline-task-activity')
    expect(html).not.toContain('inline-task-activity')
    expect(html).toContain('冒泡排序会比较相邻元素。')
    expect(html).not.toContain('message-avatar')
    expect(html).not.toContain('>小胤<')
    expect(html).toContain('添加')
    expect(html).toContain('保存为技能')
    expect(html).toContain('aria-label="检索原文"')
    expect(html).toContain('排序说明.md')
    expect(html).toContain('class="artifact-name"')
    expect(html).toContain('class="file-change-path"')
    expect(html).toContain('aria-label="文件改动"')
  })

  it('shows streamed assistant text and local attachments before completion', () => {
    const projection: XiaoyinTaskProjection = {
      status: 'running', activity: '正在处理', startedAt: '2026-09-03T10:00:00.000Z',
      updatedAt: '2026-09-03T10:00:01.000Z', steps: [], artifacts: [artifact],
    }
    const html = renderToStaticMarkup(<ChatPage
      activeModel="deepseek-v4-flash" composerRef={{ current: null }} harnessHealth="ready"
      harnessHealthDetail="正常" harnessRunning knowledgeBases={[]}
      localDirectories={[]} localFileError="" messageListRef={{ current: null }} entries={[assistantEntry('turn:1', [{ kind: 'text', id: '1:1', text: '正在列出下载目录中的文件', streaming: true }], {}, 'streaming')]} modelMenuOpen={false} modelPickerRef={{ current: null }} models={[]} onAddKnowledge={() => undefined}
      onAddLocalDirectory={() => undefined} onAddLocalFiles={() => undefined} onCancel={() => undefined}
      onEditTurn={() => undefined} onPrompt={() => undefined} onReconnect={() => undefined} onRecoverHarness={() => undefined}
      onRemoveAttachment={() => undefined} onRemoveKnowledge={() => undefined} onRemoveLocalDirectory={() => undefined}
      onSelectModel={() => undefined} onSubmit={() => undefined}
      onToggleModelMenu={() => undefined} pendingAttachments={[{
        id: 'download:image.png', rootId: 'download', rootName: '下载', path: 'image.png', name: 'image.png', kind: 'image', mediaType: 'image/png',
      }]} prompt="" runtimeStatus="ready"
      selectedKnowledgeBaseRefs={[]} taskProjection={projection}
    />)

    expect(html).toContain('正在列出下载目录中的文件')
    expect(html).toContain('streaming-response')
    expect(html).toContain('image.png')
    expect(html).toContain('sales.xlsx')
    expect(html).toContain('class="artifact-name"')
    expect(html).not.toContain('disabled="" title="发送"')
  })
})
