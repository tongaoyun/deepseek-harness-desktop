import { describe, expect, it } from 'vitest'
import { filterTeamMemberCandidates } from './team-member-picker.ts'

const expert = (slug: string, custom = false, division = 'engineering') => ({
  slug,
  name: slug,
  nameEn: slug,
  description: `${slug} 职责`,
  custom,
  division,
  conflict: false,
})

describe('专家团成员选择', () => {
  it.each(['all', 'company'] as const)('%s 来源不展示公司团队内部成员', (source) => {
    const experts = [
      expert('standalone'),
      { ...expert('bundled-member'), company: true, teamMember: true },
    ]
    for (const status of ['', 'enabled', 'disabled'] as const) {
      const enabled = status === 'disabled' ? [] : experts.map(item => item.slug)
      expect(filterTeamMemberCandidates(experts, {
        source, division: '', status, enabled, taken: [], replacing: -1, query: '',
      }).map(item => item.slug)).toEqual(['standalone'])
    }
  })

  it('已启用筛选不包含停用专家，全部和已停用仍可选停用专家', () => {
    const experts = [expert('enabled-one'), expert('disabled-one'), expert('enabled-two')]
    const enabled = ['enabled-one', 'enabled-two']
    const taken = [{ expertSlug: 'nobody' }]

    expect(filterTeamMemberCandidates(experts, {
      source: 'all', division: '', status: 'enabled', enabled, taken, replacing: -1, query: '',
    }).map(item => item.slug)).toEqual(['enabled-one', 'enabled-two'])
    expect(filterTeamMemberCandidates(experts, {
      source: 'all', division: '', status: '', enabled, taken, replacing: -1, query: '',
    }).map(item => item.slug)).toEqual(['enabled-one', 'disabled-one', 'enabled-two'])
    expect(filterTeamMemberCandidates(experts, {
      source: 'all', division: '', status: 'disabled', enabled, taken, replacing: -1, query: '',
    }).map(item => item.slug)).toEqual(['disabled-one'])
  })

  it('已占用成员除外，正在替换的那位和名称冲突的专家不进入候选', () => {
    const experts = [
      expert('kept'),
      { ...expert('taken'), conflict: true },
      expert('replacing'),
    ]
    const result = filterTeamMemberCandidates(experts, {
      source: 'all', division: '', status: '', enabled: ['kept', 'taken', 'replacing'],
      taken: [{ expertSlug: 'taken' }, { expertSlug: 'replacing' }],
      replacing: 1,
      query: '',
    })
    expect(result.map(item => item.slug)).toEqual(['kept', 'replacing'])
  })

  it('来源、分类和搜索与状态同时生效，搜索不能绕过已启用', () => {
    const experts = [
      expert('enabled-base'),
      expert('disabled-base'),
      { ...expert('enabled-custom', true, 'marketing'), name: '增长顾问', nameEn: 'growth', description: '投放' },
    ]
    expect(filterTeamMemberCandidates(experts, {
      source: 'custom', division: 'marketing', status: 'enabled', enabled: ['enabled-base', 'enabled-custom'],
      taken: [], replacing: -1, query: '增长',
    }).map(item => item.slug)).toEqual(['enabled-custom'])
    expect(filterTeamMemberCandidates(experts, {
      source: 'all', division: '', status: 'enabled', enabled: ['enabled-base'],
      taken: [], replacing: -1, query: 'disabled-base',
    })).toEqual([])
  })

  it('分类别名归入预设，未知分类归入其他且保留成员选择限制', () => {
    const experts = [
      expert('zh-category', true, '研发与集成'),
      expert('en-category', true, 'Engineering & Integration'),
      expert('unknown-category', true, 'shared'),
      expert('another-unknown', true, 'academic'),
      expert('company-unknown', false, 'shared'),
      { ...expert('conflict', true, 'shared'), conflict: true },
      { ...expert('bundled', true, 'shared'), teamMember: true },
      expert('taken', true, 'shared'),
      expert('disabled', true, 'shared'),
    ]
    const options = { source: 'custom' as const, division: 'engineering', status: 'enabled' as const,
      enabled: experts.filter(item => item.slug !== 'disabled').map(item => item.slug),
      taken: [{ expertSlug: 'taken' }], replacing: -1, query: '',
    }
    expect(filterTeamMemberCandidates(experts, options).map(item => item.slug)).toEqual(['zh-category', 'en-category'])
    expect(filterTeamMemberCandidates(experts, { ...options, division: 'specialized' }).map(item => item.slug)).toEqual(['unknown-category', 'another-unknown'])
  })
})
