import { invoke } from '@tauri-apps/api/core'
import type { InstalledExpertKit } from './types'

export interface GithubSkillInspection {
  archiveId: string
  sourceUrl: string
  candidates: { path: string; name: string; summary: string }[]
}

export const inspectGithubSkills = (sourceUrl: string) => invoke<GithubSkillInspection>('inspect_github_skills', { sourceUrl })
export const installGithubSkill = (archiveId: string, path: string) => invoke<InstalledExpertKit>('install_github_skill', { archiveId, path })
