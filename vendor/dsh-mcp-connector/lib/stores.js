/**
 * 存储域封装：connections / grants / catalog / snapshots /
 * governance / connection_scopes / tool_catalog 独立分表。
 * 所有表经产品主进程加密保存，凭证不进入 Loader 配置树或日志。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { connectionRecordSchema, connectionScopeDocumentSchema, connectionSnapshotSchema, governancePolicySchema, grantRecordSchema, catalogRecordSchema, toolCatalogRecordSchema } from './schema.js';
import { DEFAULT_ACCOUNT } from './constants.js';
import { shortHash } from './util.js';

export function defineConnectorDomain() {
  return defineDomain({
    name: 'mcp_connector',
    version: 1,
    tables: {
      connections: domainTable(connectionRecordSchema),
      grants: domainTable(grantRecordSchema),
      catalog: domainTable(catalogRecordSchema),
      snapshots: domainTable(connectionSnapshotSchema),
      governance: domainTable(governancePolicySchema),
      connection_scopes: domainTable(connectionScopeDocumentSchema),
      tool_catalog: domainTable(toolCatalogRecordSchema),
    },
  });
}

/** 最近成功工具目录；仅保存安全裁剪后的能力元数据，不含调用数据或凭据。 */
export class ToolCatalogStore {
  constructor(domain) {
    this.table = domain.tables.get('tool_catalog');
    if (!this.table) throw new Error('mcp-connector: domain table "tool_catalog" not found');
  }

  async get(key) {
    return this.table.get(key);
  }

  async put(record) {
    const next = { ...record, updatedAt: Date.now() };
    await this.table.put(record.key, next);
    return next;
  }

  async delete(key) {
    return this.table.delete(key);
  }

  async entries() {
    return [...this.table.entries()];
  }
}

/** 连接实例表 */
export class ConnectionStore {
  constructor(domain) {
    this.table = domain.tables.get('connections');
    if (!this.table) throw new Error('mcp-connector: domain table "connections" not found');
  }

  async get(key) {
    return this.table.get(key);
  }

  async put(record) {
    const next = { ...record, updatedAt: Date.now() };
    await this.table.put(record.key, next);
    return next;
  }

  async delete(key) {
    return this.table.delete(key);
  }

  async entries() {
    const out = [];
    for (const [key, value] of this.table.entries()) out.push([key, value]);
    return out;
  }
}

/** OAuth 授权表（通用多 issuer / 多账号） */
export class GrantStore {
  constructor(domain) {
    this.table = domain.tables.get('grants');
    this.refreshes = new Map();
  }
  keyFor(account, issuer, clientId, scope) {
    return `grant:${account}:${shortHash(`${issuer}|${clientId}|${scope}`)}`;
  }
  async get(key) { return this.table.get(key); }
  async put(grant) {
    const next = { ...grant, updatedAt: Date.now() };
    await this.table.put(grant.key, next);
    return next;
  }
  async delete(key) { return this.table.delete(key); }
  async entries() { return [...this.table.entries()]; }
  async withRefreshLock(key, task) {
    const prior = this.refreshes.get(key) ?? Promise.resolve();
    const pending = prior.catch(() => {}).then(task);
    this.refreshes.set(key, pending);
    try { return await pending; }
    finally { if (this.refreshes.get(key) === pending) this.refreshes.delete(key); }
  }
}

/** 目录缓存 / 本地覆盖表 */
export class CatalogStore {
  constructor(domain) {
    this.table = domain.tables.get('catalog');
    if (!this.table) throw new Error('mcp-connector: domain table "catalog" not found');
  }

  async getRemote() {
    return this.table.get('remote');
  }

  async putRemote({ etag, connectors }) {
    const record = { key: 'remote', updatedAt: Date.now(), etag: etag ?? undefined, connectors };
    await this.table.put('remote', record);
    return record;
  }

  async getOverrides() {
    return this.table.get('overrides');
  }

  async getDynamic() {
    return this.table.get('dynamic');
  }

  async putDynamic(connectors) {
    const record = { key: 'dynamic', updatedAt: Date.now(), connectors };
    await this.table.put('dynamic', record);
    return record;
  }

  async putOverrides(connectors) {
    const record = { key: 'overrides', updatedAt: Date.now(), connectors };
    await this.table.put('overrides', record);
    return record;
  }
}

/** 连接配置快照表（包含本机凭据，绝不通过公开 API 原样返回）。 */
export class SnapshotStore {
  constructor(domain) {
    this.table = domain.tables.get('snapshots');
    if (!this.table) throw new Error('mcp-connector: domain table "snapshots" not found');
  }

  async get(key) {
    return this.table.get(key);
  }

  async put(snapshot) {
    const next = { ...snapshot, updatedAt: Date.now() };
    await this.table.put(snapshot.key, next);
    return next;
  }

  async delete(key) {
    return this.table.delete(key);
  }

  async entries() {
    return [...this.table.entries()];
  }

  async trim(limit = 20) {
    const entries = await this.entries();
    entries.sort((a, b) => b[1].createdAt - a[1].createdAt || b[0].localeCompare(a[0]));
    for (const [key] of entries.slice(Math.max(0, limit))) await this.delete(key);
  }
}

/** 连接 / Server / Tool 三层治理策略；策略本身不含凭据。 */
export class GovernanceStore {
  constructor(domain) {
    this.table = domain.tables.get('governance');
    if (!this.table) throw new Error('mcp-connector: domain table "governance" not found');
  }

  async get() {
    return this.table.get('active');
  }

  async put(document) {
    const next = { ...document, key: 'active', updatedAt: document.updatedAt || Date.now() };
    await this.table.put('active', next);
    return next;
  }
}

/** 连接作用域绑定；只含 connection key / Workspace id，不含凭据。 */
export class ConnectionScopeStore {
  constructor(domain) {
    this.table = domain.tables.get('connection_scopes');
    if (!this.table) throw new Error('mcp-connector: domain table "connection_scopes" not found');
  }

  async get() {
    return this.table.get('active');
  }

  async put(document) {
    const next = { ...document, key: 'active', updatedAt: document.updatedAt || Date.now() };
    await this.table.put('active', next);
    return next;
  }
}

export { DEFAULT_ACCOUNT };
