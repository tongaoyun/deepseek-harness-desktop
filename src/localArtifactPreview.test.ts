import { invoke } from '@tauri-apps/api/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { undoLocalFileChange } from './localArtifactPreview'

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }))

beforeEach(() => vi.mocked(invoke).mockReset())

it('sends file undo fields as one strict native request', async () => {
  vi.mocked(invoke).mockResolvedValue('.xiaoyin-backups/undo/current/demo.ts')
  await undoLocalFileChange({
    id: 'change-1', rootId: 'workspace', rootName: '工作区', path: 'src/demo.ts', name: 'demo.ts',
    action: 'updated', sourceTool: 'local_files_write_text', afterHash: 'after', beforeHash: 'before',
    backupPath: '.xiaoyin-backups/turn/demo.ts', changedAt: '2026-09-13T00:00:00Z',
  })
  expect(invoke).toHaveBeenCalledWith('undo_local_file_change', {
    request: {
      rootId: 'workspace', path: 'src/demo.ts', action: 'updated', afterHash: 'after',
      beforeHash: 'before', backupPath: '.xiaoyin-backups/turn/demo.ts',
    },
  })
})
