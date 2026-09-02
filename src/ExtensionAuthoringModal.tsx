import { Plus, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createDeveloperExtension } from "./expertKits";
import {
  loadMySubmissions,
  savePersonalConnector,
  submitConnector,
  submitPackage,
  type ExtensionKind,
  type ExtensionSubmission,
} from "./extensionSubmissions";
import type {
  ConnectorCatalogEntry,
  ExpertKitManifest,
  PermissionMode,
} from "./types";

interface Props {
  initialKind: ExtensionKind;
  employeeId: string;
  accessToken: string;
  onClose: () => void;
  onSaved: (connector?: ConnectorCatalogEntry) => Promise<void> | void;
}

const defaults = {
  id: "",
  name: "",
  version: "1.0.0",
  summary: "",
  instructions: "# 使用说明\n\n请在这里描述执行步骤、输入和输出。",
  triggers: "",
  connectorRefs: "",
  requiredTools: "",
  url: "",
  toolNames: "",
  transport: "streamable-http" as const,
  authMode: "none" as const,
};

export function ExtensionAuthoringModal({
  initialKind,
  employeeId,
  accessToken,
  onClose,
  onSaved,
}: Props) {
  const [kind, setKind] = useState<ExtensionKind>(initialKind);
  const [tab, setTab] = useState<"create" | "mine">("create");
  const [form, setForm] = useState(defaults);
  const [permissions, setPermissions] = useState<
    Record<string, PermissionMode>
  >({
    localFiles: "deny",
    shell: "deny",
    computerUse: "deny",
    connectorRead: "allow",
    connectorWrite: "approval",
  });
  const [submissions, setSubmissions] = useState<ExtensionSubmission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    manifest: ExpertKitManifest;
    bytes: number[];
  }>();
  const [savedConnector, setSavedConnector] = useState<ConnectorCatalogEntry>();
  useEffect(() => {
    if (tab !== "mine") return;
    setBusy(true);
    setError("");
    void loadMySubmissions(employeeId, accessToken)
      .then(setSubmissions)
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(false));
  }, [accessToken, employeeId, tab]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setCreated(undefined);
    setSavedConnector(undefined);
    try {
      if (kind === "connector") {
        const connector: ConnectorCatalogEntry = {
          id: form.id,
          name: form.name,
          version: form.version,
          summary: form.summary,
          kind: "managed-mcp",
          scope: "PERSONAL",
          status: "ready",
          managed: false,
          transport: form.transport,
          url: form.url,
          authMode: form.authMode,
          toolNames: split(form.toolNames),
        };
        savePersonalConnector(employeeId, connector);
        setSavedConnector(connector);
        await onSaved(connector);
        setSubmissions((current) => [
          {
            kind,
            id: connector.id,
            name: connector.name,
            version: connector.version!,
            summary: connector.summary,
            status: "DRAFT",
            reviewNote: "",
            updatedAt: new Date().toISOString(),
          },
          ...current,
        ]);
      } else {
        if (kind === "skill" && split(form.triggers).length === 0)
          throw new Error("Skill 至少需要一个触发词");
        const skillId = kind === "skill" ? form.id : "main";
        const manifest: ExpertKitManifest = {
          schemaVersion: "1",
          kind,
          id: form.id,
          name: form.name,
          version: form.version,
          summary: form.summary,
          triggers: split(form.triggers),
          minimumDesktopVersion: "0.1.29",
          commands: [],
          skills: [
            {
              id: skillId,
              path: kind === "skill" ? "SKILL.md" : "skills/main/SKILL.md",
            },
          ],
          requiredTools: split(form.requiredTools),
          connectorRefs: split(form.connectorRefs),
          knowledgeBaseRefs: [],
          permissions: permissions as ExpertKitManifest["permissions"],
          serverWorkflows: [],
        };
        const value = await createDeveloperExtension(
          manifest,
          form.instructions,
        );
        setCreated({ manifest, bytes: value.bytes });
        await onSaved();
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const publish = async () => {
    setBusy(true);
    setError("");
    try {
      if (kind === "connector") {
        if (!savedConnector) throw new Error("请先保存到本机，再提交审核");
        await submitConnector(savedConnector, employeeId, accessToken);
      } else {
        if (!created) throw new Error("请先保存到本机，再提交审核");
        await submitPackage(
          created.manifest,
          created.bytes,
          employeeId,
          accessToken,
        );
      }
      setTab("mine");
      setSubmissions(await loadMySubmissions(employeeId, accessToken));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="authoring-backdrop"
      onMouseDown={onClose}
      role="presentation"
    >
      <section
        aria-modal="true"
        className="authoring-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <div>
            <strong>添加企业扩展</strong>
            <small>
              先保存为个人扩展，可立即使用；提交通过后向全公司发布。
            </small>
          </div>
          <button aria-label="关闭" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <nav>
          <button
            className={tab === "create" ? "active" : ""}
            onClick={() => setTab("create")}
            type="button"
          >
            <Plus size={14} />
            创建扩展
          </button>
          <button
            className={tab === "mine" ? "active" : ""}
            onClick={() => setTab("mine")}
            type="button"
          >
            我的创作
          </button>
        </nav>
        {tab === "mine" ? (
          <div className="submission-list">
            {busy && <p>正在加载…</p>}
            {submissions.map((item) => (
              <article key={`${item.kind}-${item.id}-${item.version}`}>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {kindLabel(item.kind)} · v{item.version}
                  </small>
                </span>
                <em className={item.status.toLowerCase()}>
                  {statusLabel(item.status)}
                </em>
                {item.reviewNote && <p>审核意见：{item.reviewNote}</p>}
              </article>
            ))}
            {!busy && submissions.length === 0 && <p>还没有提交过扩展。</p>}
          </div>
        ) : (
          <form onSubmit={save}>
            <div className="authoring-kind">
              {(["expert-kit", "skill", "connector"] as const).map((value) => (
                <button
                  className={kind === value ? "active" : ""}
                  key={value}
                  onClick={() => {
                    setKind(value);
                    setCreated(undefined);
                    setSavedConnector(undefined);
                  }}
                  type="button"
                >
                  {kindLabel(value)}
                </button>
              ))}
            </div>
            <div className="authoring-grid">
              <label>
                ID
                <input
                  pattern="[A-Za-z0-9._-]+"
                  required
                  value={form.id}
                  onChange={(event) =>
                    setForm({ ...form, id: event.target.value })
                  }
                />
              </label>
              <label>
                名称
                <input
                  required
                  value={form.name}
                  onChange={(event) =>
                    setForm({ ...form, name: event.target.value })
                  }
                />
              </label>
              <label>
                版本
                <input
                  pattern="[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?"
                  required
                  value={form.version}
                  onChange={(event) =>
                    setForm({ ...form, version: event.target.value })
                  }
                />
              </label>
              <label className="wide">
                说明
                <input
                  required
                  value={form.summary}
                  onChange={(event) =>
                    setForm({ ...form, summary: event.target.value })
                  }
                />
              </label>
              {kind === "connector" ? (
                <>
                  <label>
                    传输
                    <select
                      value={form.transport}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          transport: event.target
                            .value as typeof form.transport,
                        })
                      }
                    >
                      <option value="streamable-http">Streamable HTTP</option>
                      <option value="sse">SSE</option>
                    </select>
                  </label>
                  <label>
                    认证
                    <select
                      value={form.authMode}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          authMode: event.target.value as typeof form.authMode,
                        })
                      }
                    >
                      <option value="none">无</option>
                      <option value="employee-bearer">员工 Bearer Token</option>
                    </select>
                  </label>
                  <label className="wide">
                    MCP 地址
                    <input
                      placeholder="https://mcp.example.com/mcp"
                      required
                      type="url"
                      value={form.url}
                      onChange={(event) =>
                        setForm({ ...form, url: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide">
                    工具名称
                    <input
                      placeholder="可选，多个用逗号分隔"
                      value={form.toolNames}
                      onChange={(event) =>
                        setForm({ ...form, toolNames: event.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    触发词
                    <input
                      placeholder="多个用逗号分隔"
                      value={form.triggers}
                      onChange={(event) =>
                        setForm({ ...form, triggers: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    连接器 IDs
                    <input
                      value={form.connectorRefs}
                      onChange={(event) =>
                        setForm({ ...form, connectorRefs: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide">
                    所需工具
                    <input
                      value={form.requiredTools}
                      onChange={(event) =>
                        setForm({ ...form, requiredTools: event.target.value })
                      }
                    />
                  </label>
                  <label className="wide">
                    执行说明
                    <textarea
                      required
                      value={form.instructions}
                      onChange={(event) =>
                        setForm({ ...form, instructions: event.target.value })
                      }
                    />
                  </label>
                  <fieldset className="wide">
                    <legend>权限</legend>
                    {Object.keys(permissions).map((key) => (
                      <label key={key}>
                        {permissionLabel(key)}
                        <select
                          value={permissions[key]}
                          onChange={(event) =>
                            setPermissions({
                              ...permissions,
                              [key]: event.target.value as PermissionMode,
                            })
                          }
                        >
                          <option value="deny">禁止</option>
                          <option value="approval">需确认</option>
                          <option value="allow">允许</option>
                        </select>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
            </div>
            {error && <div className="authoring-error">{error}</div>}
            <footer>
              <button disabled={busy} type="submit">
                {busy ? "正在保存…" : "保存到本机"}
              </button>
              <button
                className="primary"
                disabled={busy || (kind === "connector" ? !savedConnector : !created)}
                onClick={() => void publish()}
                type="button"
              >
                <Send size={14} />
                提交审核
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function split(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function kindLabel(value: ExtensionKind) {
  return value === "expert-kit"
    ? "专家套件"
    : value === "skill"
      ? "Skill"
      : "MCP 连接器";
}
function statusLabel(value: ExtensionSubmission["status"]) {
  return {
    DRAFT: "个人草稿",
    SUBMITTED: "待审核",
    CHANGES_REQUESTED: "待修改",
    REJECTED: "已拒绝",
    PUBLISHED: "已发布",
    UNPUBLISHED: "已下架",
  }[value];
}
function permissionLabel(value: string) {
  return (
    {
      localFiles: "本地文件",
      shell: "Shell",
      computerUse: "电脑操作",
      connectorRead: "连接器读取",
      connectorWrite: "连接器写入",
    } as Record<string, string>
  )[value];
}
