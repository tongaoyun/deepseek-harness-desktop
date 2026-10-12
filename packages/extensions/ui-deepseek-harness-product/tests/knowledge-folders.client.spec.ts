// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { knowledgeFolderTrail } from '../src/client/knowledge-folders.ts'
import { knowledgeFolder } from '../src/client/knowledge-data.ts'

it('resolves nested stable identities independently of duplicate names and input order', () => {
  const folders = [
    { id: 'child', name: '资料', parentId: 'root' },
    { id: 'other', name: '资料', parentId: null },
    { id: 'root', name: '项目', parentId: null },
    { id: 'leaf', name: '记录', parentId: 'child' },
  ]
  expect(knowledgeFolderTrail(folders, 'leaf').map(folder => folder.id)).toEqual(['root', 'child', 'leaf'])
  expect(knowledgeFolderTrail(folders, null)).toEqual([])
  expect(knowledgeFolderTrail(folders, undefined)).toEqual([])
  expect(knowledgeFolderTrail(folders, 'other').map(folder => folder.name)).toEqual(['资料'])
})

it('rejects missing parents, cycles and missing hierarchy metadata before rendering paths', () => {
  expect(() => knowledgeFolderTrail([{ id: 'child', name: '资料', parentId: 'missing' }], 'child')).toThrow('hierarchy')
  expect(() => knowledgeFolderTrail([{ id: 'cycle', name: '资料', parentId: 'cycle' }], 'cycle')).toThrow('hierarchy')
  expect(() => knowledgeFolder({ id: 'old', name: '旧数据' })).toThrow('response')
  expect(knowledgeFolder({ id: 'new', name: '资料', parentId: null })).toEqual({ id: 'new', name: '资料', parentId: null })
})
