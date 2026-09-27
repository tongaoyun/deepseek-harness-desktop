import { Copy, Pencil, Plus, RefreshCw, Send, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  createDeveloperExtension,
  listInstalledExtensions,
  packageDeveloperExtension,
  readDeveloperExtension,
  removeDeveloperExtension,
} from './expertKits'
import {
  loadMySubmissions,
  loadPersonalConnectors,
  submitConnector,
  submitPackage,
  type ExtensionKind,
  type ExtensionSubmission,
  type ExtensionValidationReport,
} from './extensionSubmissions'
import { deriveSkillDependencies, ExpertKitComposer } from './ExpertKitComposer'
import {
  applyConnectorSecrets,
  connectorSecretTemplate,
  connectorSecretValues,
  type ConnectorSecretValues,
} from './connectorSecrets'
import { ExtensionPreviewPanel, type ExtensionPreviewConfig } from './ExtensionPreviewPanel'
import { diagnoseConnectors } from './harness'
import { connectorId } from './connectorImport'
import { useDesktopDialog } from './DesktopDialog'
import {
  connectorCategories,
  connectorCategoryLabel,
  extensionCategories,
  extensionCategoryLabel,
  type ConnectorCategory,
  type ExtensionCategory,
} from './extensionCategories'
import type { SkillView } from './skills'
import type {
  ConnectorCatalogEntry,
  ConnectorDiagnosticResult,
  ConnectorAuthMode,
  ConnectorTransport,
  ExpertKitManifest,
} from './types'

export type AuthoringChange =
  | { type: 'connector-upsert'; connector: ConnectorCatalogEntry; secrets: ConnectorSecretValues }
  | { type: 'connector-delete'; id: string }
  | { type: 'extension-change' }

interface Props {
  initialKind: ExtensionKind
  initialInstructions?: string
  initialConnector?: ConnectorCatalogEntry
  employeeId: string
  sessionToken: string
  skills: SkillView[]
  connectors: ConnectorCatalogEntry[]
  connectorSecrets: Record<string, ConnectorSecretValues>
  previewConfig?: ExtensionPreviewConfig
  previewUnavailableReason?: string
  onPreviewRunningChange: (running: boolean) => void
  onClose: () => void
  onChanged: (change: AuthoringChange) => Promise<void> | void
}

interface LocalCreation {
  kind: ExtensionKind
  id: string
  name: string
  version: string
  summary: string
  category: ExtensionCategory | ConnectorCategory
  connector?: ConnectorCatalogEntry
}

interface AuthoringForm {
  id: string
  name: string
  author: string
  version: string
  summary: string
  category: ExtensionCategory | ConnectorCategory
  instructions: string
  triggers: string
  allowImplicitInvocation: boolean
  connectorRefs: string
  requiredTools: string
  url: string
  command: string
  arguments: string
  environment: string
  headers: string
  toolNames: string
  transport: ConnectorTransport
  authMode: ConnectorAuthMode
}

const defaults: AuthoringForm = {
  id: '', name: '', author: '', version: '1.0.0', summary: '', category: 'other',
  instructions: '# 使用说明\n\n请在这里描述执行步骤、输入和输出。',
  triggers: '', allowImplicitInvocation: true, connectorRefs: '', requiredTools: '', url: '', command: '', arguments: '',
  environment: '', headers: '', toolNames: '',
  transport: 'streamable-http',
  authMode: 'none',
}

export function ExtensionAuthoringModal({
  initialKind, initialInstructions = '', initialConnector, employeeId, sessionToken, skills, connectors, connectorSecrets, previewConfig,
  previewUnavailableReason, onPreviewRunningChange, onClose, onChanged,
}: Props) {
  const { confirm, dialog } = useDesktopDialog()
  const [kind, setKind] = useState<ExtensionKind>(initialKind)
  const [tab, setTab] = useState<'create' | 'mine'>('create')
  const initialForm = (nextKind: ExtensionKind): AuthoringForm => nextKind === initialKind
    && nextKind !== 'connector' && initialInstructions.trim()
    ? { ...defaults, instructions: initialInstructions.trim() }
    : { ...defaults }
  const [form, setForm] = useState(() => initialConnector ? connectorForm(applyConnectorSecrets(initialConnector, connectorSecrets[initialConnector.id])) : initialForm(initialKind))
  const [submissions, setSubmissions] = useState<ExtensionSubmission[]>([])
  const [localCreations, setLocalCreations] = useState<LocalCreation[]>([])
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [baseManifest, setBaseManifest] = useState<ExpertKitManifest>()
  const [editing, setEditing] = useState<{ kind: ExtensionKind; id: string; version: string } | undefined>(() => initialConnector ? { kind: 'connector', id: initialConnector.id, version: initialConnector.version ?? '1.0.0' } : undefined)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [previewRunning, setPreviewRunning] = useState(false)
  const [error, setError] = useState('')
  const [diagnostic, setDiagnostic] = useState<ConnectorDiagnosticResult>()
  const [created, setCreated] = useState<{ manifest: ExpertKitManifest; bytes: number[]; sha256: string }>()
  const [savedConnector, setSavedConnector] = useState<ConnectorCatalogEntry>()
  const [savedFingerprint, setSavedFingerprint] = useState('')
  const [validationEvidence, setValidationEvidence] = useState<{ fingerprint: string; report: ExtensionValidationReport }>()
  const draftFingerprint = JSON.stringify({ kind, form, selectedSkillIds })
  const currentDraftSaved = savedFingerprint === draftFingerprint

  const refreshMine = async () => {
    setBusy(true)
    setError('')
    try {
      const [serverResult, installedResult] = await Promise.allSettled([
        loadMySubmissions(employeeId, sessionToken),
        listInstalledExtensions(),
      ])
      if (serverResult.status === 'fulfilled') setSubmissions(serverResult.value)
      else setError(serverResult.reason instanceof Error ? serverResult.reason.message : String(serverResult.reason))
      const installed = installedResult.status === 'fulfilled'
        ? installedResult.value.filter((item) => item.source === 'developer').map((item): LocalCreation => ({
          kind: item.manifest.kind,
          id: item.manifest.id,
          name: item.manifest.name,
          version: item.manifest.version,
          summary: item.manifest.summary,
          category: item.manifest.category,
        }))
        : []
      const connectors = loadPersonalConnectors(employeeId).map((connector): LocalCreation => ({
        kind: 'connector', id: connector.id, name: connector.name,
        version: connector.version ?? '1.0.0', summary: connector.summary, category: connector.category, connector,
      }))
      setLocalCreations([...connectors, ...installed])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (tab === 'mine') void refreshMine()
  }, [tab]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const locals = new Map(localCreations.map((item) => [coordinate(item), item]))
    const values: Array<{ submission?: ExtensionSubmission; local?: LocalCreation }> = submissions.map((submission) => ({ submission, local: locals.get(coordinate(submission)) }))
    const submitted = new Set(submissions.map(coordinate))
    for (const local of localCreations) {
      if (!submitted.has(coordinate(local))) values.push({ submission: undefined, local })
    }
    return values.sort((left, right) => (right.submission?.updatedAt ?? '').localeCompare(left.submission?.updatedAt ?? ''))
  }, [localCreations, submissions])

  const resetDraftState = () => {
    setCreated(undefined)
    setSavedConnector(undefined)
    setDiagnostic(undefined)
    setError('')
    setSavedFingerprint('')
    setValidationEvidence(undefined)
  }

  const startNew = (nextKind = kind) => {
    setBaseManifest(undefined)
    setKind(nextKind)
    setForm(initialForm(nextKind))
    setSelectedSkillIds([])
    setEditing(undefined)
    resetDraftState()
    setTab('create')
  }

  const fillConnector = (connector: ConnectorCatalogEntry, mode: 'edit' | 'copy' | 'upgrade') => {
    setBaseManifest(undefined)
    const configured = applyConnectorSecrets(connector, connectorSecrets[connector.id])
    const version = mode === 'upgrade' ? bumpVersion(connector.version ?? '1.0.0') : mode === 'copy' ? '1.0.0' : connector.version ?? '1.0.0'
    setKind('connector')
    setForm({
      ...connectorForm(configured),
      id: mode === 'copy' ? `${connector.id}-copy` : connector.id,
      name: mode === 'copy' ? `${connector.name} 副本` : connector.name,
      version,
    })
    setEditing(mode === 'edit' ? { kind: 'connector', id: connector.id, version: connector.version ?? '1.0.0' } : undefined)
    resetDraftState()
    setTab('create')
  }

  const fillPackage = async (local: LocalCreation, mode: 'edit' | 'copy' | 'upgrade') => {
    if (local.kind === 'connector') return
    setBusy(true)
    setError('')
    try {
      const draft = await readDeveloperExtension(local.kind, local.id, local.version)
      const manifest = draft.manifest
      setBaseManifest(manifest)
      const nextVersion = mode === 'upgrade' ? bumpVersion(manifest.version) : mode === 'copy' ? '1.0.0' : manifest.version
      setKind(local.kind)
      setForm({
        ...defaults,
        id: mode === 'copy' ? `${manifest.id}-copy` : manifest.id,
        name: mode === 'copy' ? `${manifest.name} 副本` : manifest.name,
        author: manifest.author ?? '',
        version: nextVersion,
        summary: manifest.summary,
        category: manifest.category,
        instructions: draft.instructions,
        triggers: (manifest.triggers ?? []).join(', '),
        allowImplicitInvocation: manifest.allowImplicitInvocation ?? true,
        connectorRefs: manifest.connectorRefs.join(', '),
        requiredTools: manifest.requiredTools.join(', '),
      })
      setSelectedSkillIds(local.kind === 'expert-kit'
        ? manifest.skills.map((skill) => skill.id).filter((id) => id !== 'main')
        : [])
      setEditing(mode === 'edit' ? { kind: local.kind, id: local.id, version: local.version } : undefined)
      resetDraftState()
      setTab('create')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setCreated(undefined)
    setSavedConnector(undefined)
    try {
      if (kind === 'connector') {
        const connector = connectorFromForm(form)
        if (editing) connector.id = editing.id
        const template = connectorSecretTemplate(connector)
        const secrets = connectorSecretValues(connector)
        await onChanged({ type: 'connector-upsert', connector: template, secrets })
        setSavedConnector(connector)
        setSavedFingerprint(draftFingerprint)
        setEditing({ kind, id: connector.id, version: connector.version! })
      } else {
        const generated = manifestFromForm(kind, form, selectedSkillIds)
        const manifest = baseManifest ? { ...generated, commands: baseManifest.commands, skills: baseManifest.skills, knowledgeBaseRefs: baseManifest.knowledgeBaseRefs } : generated
        const skillSources = kind === 'expert-kit' && !baseManifest ? selectedSkillIds.map((id) => {
          const skill = skills.find((item) => item.id === id && item.installed)
          if (!skill?.installedVersion) throw new Error(`技能 ${id} 尚未安装到本机`)
          return { id, version: skill.installedVersion }
        }) : []
        const value = await createDeveloperExtension(manifest, form.instructions, skillSources, baseManifest ? { id: baseManifest.id, version: baseManifest.version } : undefined)
        setBaseManifest(manifest)
        setCreated({ manifest, bytes: value.bytes, sha256: value.installed.packageSha256 ?? '' })
        setSavedFingerprint(draftFingerprint)
        setEditing({ kind, id: manifest.id, version: manifest.version })
        await onChanged({ type: 'extension-change' })
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    setBusy(true)
    setError('')
    try {
      if (!currentDraftSaved) throw new Error('当前内容有修改，请先重新保存到本机')
      if (kind === 'connector') {
        if (!savedConnector) throw new Error('请先保存到本机，再提交审核')
        await submitConnector(savedConnector, employeeId, sessionToken,
          validationEvidence?.fingerprint === draftFingerprint ? validationEvidence.report : undefined)
      } else {
        if (!created) throw new Error('请先保存到本机，再提交审核')
        await submitPackage(created.manifest, created.bytes, employeeId, sessionToken,
          validationEvidence?.fingerprint === draftFingerprint ? validationEvidence.report : undefined)
      }
      setTab('mine')
      await refreshMine()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const resubmit = async (local: LocalCreation) => {
    setBusy(true)
    setError('')
    try {
      if (local.kind === 'connector') {
        if (!local.connector) throw new Error('本机连接器草稿不存在')
        await submitConnector(local.connector, employeeId, sessionToken)
      } else {
        const packaged = await packageDeveloperExtension(local.kind, local.id, local.version)
        await submitPackage(packaged.installed.manifest, packaged.bytes, employeeId, sessionToken)
      }
      await refreshMine()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const removeLocal = async (local: LocalCreation) => {
    if (!await confirm({
      title: `删除本机扩展“${local.name}”？`,
      message: `将删除本机 v${local.version} 草稿，已发布的企业版本不受影响。`,
      confirmLabel: '删除',
      danger: true,
    })) return
    setBusy(true)
    setError('')
    try {
      if (local.kind === 'connector') {
        await onChanged({ type: 'connector-delete', id: local.id })
      } else {
        await removeDeveloperExtension(local.kind, local.id, local.version)
        await onChanged({ type: 'extension-change' })
      }
      await refreshMine()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const testConnector = async () => {
    setTesting(true)
    setError('')
    setDiagnostic(undefined)
    try {
      if (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim()) {
        throw new Error(form.transport === 'stdio' ? '请先填写启动命令' : '请先填写 MCP 地址')
      }
      const id = connectorId(form.id.trim() || form.name.trim() || 'connector-draft')
      const [result] = await diagnoseConnectors({
        employeeId,
        sessionToken,
        connectors: [{
          id, name: form.name.trim() || id, version: form.version, status: 'ready', enabled: true,
          transport: form.transport, url: form.url.trim(), authMode: form.authMode, toolNames: [],
        }],
      })
      if (!result) throw new Error('连接测试没有返回结果')
      setDiagnostic(result)
      if (result.status !== 'ready' && result.status !== 'drift') throw new Error(result.error || 'MCP 服务尚未就绪')
      const nextForm = result.discoveredTools.length > 0 ? { ...form, toolNames: result.discoveredTools.join(', ') } : form
      if (nextForm !== form) setForm(nextForm)
      setValidationEvidence({
        fingerprint: JSON.stringify({ kind, form: nextForm, selectedSkillIds }),
        report: {
          type: 'CONNECTOR_DIAGNOSTIC', status: 'PASSED', prompt: '', model: '',
          latencyMs: result.latencyMs, discoveredTools: result.discoveredTools,
          steps: [{ kind: 'tool', label: '连接 MCP 服务并发现工具', status: 'completed', toolName: 'tools/list' }],
          artifacts: [], finalResponse: '', completedAt: new Date().toISOString(),
        },
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setTesting(false)
    }
  }

  const updateSelectedSkills = (ids: string[]) => {
    const before = deriveSkillDependencies(skills, selectedSkillIds)
    const after = deriveSkillDependencies(skills, ids)
    const manualConnectors = split(form.connectorRefs).filter((id) => !before.connectorIds.includes(id))
    const manualTools = split(form.requiredTools).filter((tool) => !before.tools.includes(tool))
    setSelectedSkillIds(ids)
    setForm((current) => ({
      ...current,
      connectorRefs: unique([...manualConnectors, ...after.connectorIds]).join(', '),
      requiredTools: unique([...manualTools, ...after.tools]).join(', '),
    }))
  }

  return <div className="authoring-backdrop" onMouseDown={onClose} role="presentation">
    <section aria-modal="true" className="authoring-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
      <header><div><strong>企业扩展创作中心</strong><small>个人扩展可立即使用；提交审核通过后向全公司发布。</small></div><button aria-label="关闭" onClick={onClose} type="button"><X size={16} /></button></header>
      <nav>
        <button className={tab === 'create' ? 'active' : ''} onClick={() => startNew()} type="button"><Plus size={14} />创建扩展</button>
        <button className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')} type="button">我的创作</button>
      </nav>
      {tab === 'mine' ? <div className="submission-list">
        {busy && <p>正在加载…</p>}
        {error && <div className="authoring-error">{error}</div>}
        {rows.map(({ submission, local }) => {
          const item = submission ?? local!
          return <article key={coordinate(item)}>
            <span><strong>{item.name}</strong><small>{kindLabel(item.kind)} · {categoryLabel(item.kind, item.category)} · v{item.version}{local ? ' · 本机可用' : ' · 本机草稿已删除'}{submission?.validationReport?.status === 'PASSED' ? ' · 已附验证结果' : ''}</small></span>
            <em className={(submission?.status ?? 'DRAFT').toLowerCase()}>{statusLabel(submission?.status ?? 'DRAFT')}</em>
            {submission?.reviewNote && <p>审核意见：{submission.reviewNote}</p>}
            {local && <div className="submission-actions">
              <button disabled={busy} onClick={() => local.kind === 'connector' ? fillConnector(local.connector!, 'edit') : void fillPackage(local, 'edit')} type="button"><Pencil size={12} />编辑</button>
              <button disabled={busy} onClick={() => local.kind === 'connector' ? fillConnector(local.connector!, 'copy') : void fillPackage(local, 'copy')} type="button"><Copy size={12} />复制</button>
              <button disabled={busy} onClick={() => local.kind === 'connector' ? fillConnector(local.connector!, 'upgrade') : void fillPackage(local, 'upgrade')} type="button"><RefreshCw size={12} />版本升级</button>
              {submission?.status === 'CHANGES_REQUESTED' && <button className="primary" disabled={busy} onClick={() => void resubmit(local)} type="button"><Send size={12} />原版本重提</button>}
              <button className="danger" disabled={busy} onClick={() => void removeLocal(local)} type="button"><Trash2 size={12} />删除本机</button>
            </div>}
          </article>
        })}
        {!busy && rows.length === 0 && <p>还没有本地扩展或审核记录。</p>}
      </div> : <form onSubmit={save}>
        {!editing && initialInstructions.trim() && kind === initialKind && <div className="authoring-mode">已带入小胤生成的初稿。请确认名称、分类和执行说明后保存到本机。</div>}
        {editing && <div className="authoring-mode">正在编辑 {kindLabel(editing.kind)}：{editing.id} · v{editing.version}，保存会更新本机草稿。</div>}
        <div className="authoring-kind">{(['skill', 'expert-kit', 'connector'] as const).map((value) => <button className={kind === value ? 'active' : ''} disabled={Boolean(editing)} key={value} onClick={() => startNew(value)} type="button">{kindLabel(value)}</button>)}</div>
        <div className="authoring-grid">
          <label>{kind === 'connector' ? 'ID（可选）' : 'ID'}<input disabled={Boolean(editing)} pattern={kind === 'connector' ? undefined : '[A-Za-z0-9._-]+'} placeholder={kind === 'connector' ? '留空时根据名称自动生成' : undefined} required={kind !== 'connector'} value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} /></label>
          <label>名称<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
          {kind !== 'connector' && <label>作者<input maxLength={80} value={form.author} onChange={(event) => setForm({ ...form, author: event.target.value })} /></label>}
          <label>版本<input disabled={Boolean(editing)} pattern="[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?" required value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} /></label>
          <label>分类<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value as AuthoringForm['category'] })}>{(kind === 'connector' ? connectorCategories : extensionCategories).map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}</select></label>
          <label className="wide">说明<input required value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></label>
          {kind === 'connector' ? <>
            <label>传输<select value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value as typeof form.transport })}><option value="streamable-http">Streamable HTTP</option><option value="stdio">stdio 本地进程</option></select></label>
            {form.transport !== 'stdio' && <label>认证<select value={form.authMode} onChange={(event) => setForm({ ...form, authMode: event.target.value as typeof form.authMode })}><option value="none">无</option><option value="employee-bearer">员工 Bearer Token</option><option value="erp-cookie">ERP 扫码会话</option></select></label>}
            {form.transport === 'stdio' ? <>
              <label className="wide">启动命令<input placeholder="例如 npx" required value={form.command} onChange={(event) => { setForm({ ...form, command: event.target.value }); setDiagnostic(undefined); setValidationEvidence(undefined) }} /></label>
              <label className="wide">命令参数<textarea placeholder={'每行一个参数，例如：\n-y\n@modelcontextprotocol/server-filesystem'} value={form.arguments} onChange={(event) => setForm({ ...form, arguments: event.target.value })} /><small>参数会随连接器发布；Token 等敏感值请放到环境变量中。</small></label>
              <label className="wide">环境变量（JSON）<textarea placeholder={'例如：{\n  "API_KEY": "..."\n}'} value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })} /></label>
            </> : <>
              <label className="wide">MCP 地址<input placeholder="https://mcp.example.com/mcp" required type="url" value={form.url} onChange={(event) => { setForm({ ...form, url: event.target.value }); setDiagnostic(undefined); setValidationEvidence(undefined) }} /><small>地址会随连接器发布，请勿把 Token 放在 URL 查询参数中。</small></label>
              <label className="wide">自定义 Headers（JSON）<textarea placeholder={'例如：{\n  "Authorization": "Bearer ..."\n}'} value={form.headers} onChange={(event) => setForm({ ...form, headers: event.target.value })} /></label>
            </>}
            <label className="wide">工具名称<input placeholder="测试连接后自动回填，也可手工修改" value={form.toolNames} onChange={(event) => setForm({ ...form, toolNames: event.target.value })} /></label>
            <div className="connector-authoring-test wide"><button disabled={testing || busy} onClick={() => void testConnector()} type="button"><RefreshCw className={testing ? 'spin' : ''} size={13} />{testing ? '正在连接…' : '测试连接并发现工具'}</button>{diagnostic && diagnostic.status !== 'unavailable' && <span>{diagnostic.status === 'ready' ? '连接成功' : '连接成功，登记工具有变化'} · {diagnostic.latencyMs} ms · 发现 {diagnostic.discoveredTools.length} 个工具</span>}</div>
          </> : <>
            {kind === 'expert-kit' && !baseManifest && <ExpertKitComposer
              connectors={connectors}
              onConnectorsChange={(ids) => setForm({ ...form, connectorRefs: ids.join(', ') })}
              onSkillsChange={updateSelectedSkills}
              onToolsChange={(tools) => setForm({ ...form, requiredTools: tools.join(', ') })}
              selectedConnectorIds={split(form.connectorRefs)}
              selectedSkillIds={selectedSkillIds}
              selectedTools={split(form.requiredTools)}
              skills={skills}
            />}
            {kind === 'skill' && <label>触发词<input placeholder="多个用逗号分隔" value={form.triggers} onChange={(event) => setForm({ ...form, triggers: event.target.value })} /></label>}
            {kind === 'skill' && <label>连接器 IDs<input value={form.connectorRefs} onChange={(event) => setForm({ ...form, connectorRefs: event.target.value })} /></label>}
            {kind === 'skill' && <label className="wide">所需工具<input value={form.requiredTools} onChange={(event) => setForm({ ...form, requiredTools: event.target.value })} /></label>}
            <label className="authoring-switch wide"><span><strong>允许自动调用</strong><small>关闭后只在员工明确选择该能力时加载</small></span><input aria-label="允许自动调用" checked={form.allowImplicitInvocation} onChange={(event) => setForm({ ...form, allowImplicitInvocation: event.target.checked })} role="switch" type="checkbox" /></label>
            <label className="wide">{kind === 'skill' ? '执行说明' : '岗位、工作流程与交付标准'}<textarea required value={form.instructions} onChange={(event) => setForm({ ...form, instructions: event.target.value })} /></label>
            {baseManifest && <div className="expert-composer-packaging wide">编辑保留原有技能、命令和辅助资源。需要调整套件结构时，请从详情页创建定制副本。</div>}
            {!baseManifest && kind === 'expert-kit' && selectedSkillIds.length > 0 && <div className="expert-composer-packaging wide">保存时会把 {selectedSkillIds.length} 个已安装技能及其辅助资源复制进套件，套件可独立安装和审核。</div>}
          </>}
        </div>
        {kind !== 'connector' && <ExtensionPreviewPanel
          config={previewConfig}
          onReport={(report) => setValidationEvidence({ fingerprint: draftFingerprint, report })}
          onRunningChange={(running) => {
            setPreviewRunning(running)
            onPreviewRunningChange(running)
          }}
          target={created && currentDraftSaved ? {
            kind: created.manifest.kind,
            id: created.manifest.id,
            version: created.manifest.version,
            sha256: created.sha256,
            knowledgeBaseRefs: created.manifest.knowledgeBaseRefs ?? [],
            allowLocalFiles: true,
          } : undefined}
          unavailableReason={previewUnavailableReason}
        />}
        {error && <div className="authoring-error">{error}</div>}
        <footer><button disabled={busy || testing || previewRunning} type="submit">{busy ? '正在保存…' : editing ? '更新本机草稿' : '保存到本机'}</button><button className="primary" disabled={busy || testing || previewRunning || !currentDraftSaved || (kind === 'connector' ? !savedConnector : !created)} onClick={() => void publish()} type="button"><Send size={14} />提交审核</button></footer>
      </form>}
    </section>
    {dialog}
  </div>
}

function connectorForm(connector: ConnectorCatalogEntry): AuthoringForm {
  return {
    ...defaults, id: connector.id, name: connector.name, version: connector.version ?? '1.0.0',
    summary: connector.summary, category: connector.category,
    url: connector.url ?? '', command: connector.command ?? '',
    arguments: (connector.arguments ?? []).join('\n'),
    environment: formatRecord(connector.environment), headers: formatRecord(connector.headers),
    toolNames: connector.toolNames.join(', '),
    transport: connector.transport === 'stdio' ? connector.transport : 'streamable-http',
    authMode: connector.authMode ?? 'none',
  }
}

function connectorFromForm(form: AuthoringForm): ConnectorCatalogEntry {
  return { id: connectorId(form.id.trim() || form.name.trim()), name: form.name, version: form.version, summary: form.summary, category: form.category as ConnectorCategory, kind: 'personal-mcp', scope: 'PERSONAL', status: 'ready', managed: false, transport: form.transport, url: form.transport === 'stdio' ? '' : form.url.trim(), authMode: form.transport === 'stdio' ? 'none' : form.authMode, toolNames: split(form.toolNames), readOnlyTools: [], command: form.transport === 'stdio' ? form.command.trim() : '', arguments: form.transport === 'stdio' ? lines(form.arguments) : [], environment: form.transport === 'stdio' ? parseRecord(form.environment, '环境变量') : {}, headers: form.transport === 'stdio' ? {} : parseRecord(form.headers, 'Headers') }
}

function manifestFromForm(kind: 'expert-kit' | 'skill', form: AuthoringForm, selectedSkillIds: string[]): ExpertKitManifest {
  const requiredTools = split(form.requiredTools)
  const connectorRefs = split(form.connectorRefs)
  const dependencyFields = { requiredTools, connectorRefs, knowledgeBaseRefs: [] as string[] }
  return {
    schemaVersion: kind === 'expert-kit' ? '3' : '1', kind, id: form.id, name: form.name, author: form.author.trim() || undefined, version: form.version, summary: form.summary, category: form.category as ExtensionCategory,
    triggers: split(form.triggers), allowImplicitInvocation: form.allowImplicitInvocation, minimumDesktopVersion: '0.1.41', commands: kind === 'expert-kit' ? [{ id: 'start', path: 'commands/start.md', skillId: `guide-${form.id}` }] : [],
    skills: kind === 'expert-kit'
      ? [{ id: `guide-${form.id}`, path: 'skills/kit-guide/SKILL.md', ...dependencyFields }, ...selectedSkillIds.map((id) => ({ id, path: `skills/${id}/SKILL.md`, ...dependencyFields }))]
      : [{ id: form.id, path: 'SKILL.md' }],
    requiredTools, connectorRefs, knowledgeBaseRefs: [],
  }
}

function split(value: string) { return value.split(',').map((item) => item.trim()).filter(Boolean) }
function lines(value: string) { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) }
function parseRecord(value: string, label: string): Record<string, string> {
  if (!value.trim()) return {}
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`${label} 必须是 JSON 对象`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.values(parsed).some((item) => typeof item !== 'string')) throw new Error(`${label} 的键和值必须是字符串`)
  return parsed as Record<string, string>
}
function formatRecord(value?: Record<string, string>) { return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '' }
function unique(values: string[]) { return [...new Set(values)] }
function coordinate(value: Pick<LocalCreation, 'kind' | 'id' | 'version'>) { return `${value.kind}:${value.id}:${value.version}` }
function bumpVersion(value: string) { const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value); return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : '1.0.0' }
function kindLabel(value: ExtensionKind) { return value === 'expert-kit' ? '专家套件' : value === 'skill' ? '技能' : 'MCP 连接器' }
function categoryLabel(kind: ExtensionKind, value: string) { return kind === 'connector' ? connectorCategoryLabel(value) : extensionCategoryLabel(value) }
function statusLabel(value: ExtensionSubmission['status']) { return { DRAFT: '个人草稿', SUBMITTED: '待审核', CHANGES_REQUESTED: '待修改', REJECTED: '已拒绝', PUBLISHED: '已发布', UNPUBLISHED: '已下架' }[value] }
