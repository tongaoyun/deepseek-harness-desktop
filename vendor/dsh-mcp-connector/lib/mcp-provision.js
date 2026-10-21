/**
 * MCP 条目动态配置：通过 ctx.loader 创建/更新/停用/移除 @deepseek-ai/dsh-mcp-client 条目。
 * entryId = {entryPrefix}-{record.key}；serverName 决定工具名前缀，生命周期内不变 → 幂等。
 */

import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { cliBridgeArgs } from './cli-providers.js';
import { effectiveLocalRecord } from './local-overrides.js';
import { fileURLToPath } from 'node:url';

const STDIO_STARTUP_GUARD = fileURLToPath(new URL('./stdio-startup-guard.js', import.meta.url));

/**
 * 桌面宿主（Electron 内嵌 DSH）的 `process.execPath` 是可执行文件本体：只有带上
 * `ELECTRON_RUN_AS_NODE` 才会作为 Node 运行 guard 脚本；CLI 宿主（node 进程）不需要。
 * 该变量只服务于 guard 自身，guard 启动真实 server 前会把它移除。
 */
function isElectronRuntime() {
  return typeof process.versions?.electron === 'string';
}

export function entryIdFor(config, record) {
  return `${config.entryPrefix}-${record.key}`;
}

/** 由连接记录 + grant 集合构造条目 headers（含鉴权头） */
export function authHeaders(record, grants) {
  const headers = { ...(record.headers ?? {}) };
  if (!record.auth) return headers;
  if (record.auth.mode === 'oauth') {
    const grant = record.auth.grantKey ? grants.get(record.auth.grantKey) : null;
    if (grant?.accessToken) headers.Authorization = `Bearer ${grant.accessToken}`;
  } else if (record.auth.mode === 'bearer') {
    if (record.auth.bearerToken) headers.Authorization = `Bearer ${record.auth.bearerToken}`;
  } else if (record.auth.mode === 'api-key') {
    if (record.auth.apiKeyHeader && record.auth.apiKeyValue !== undefined && record.auth.apiKeyValue !== '') {
      headers[record.auth.apiKeyHeader] = record.auth.apiKeyValue;
    }
  }
  return headers;
}

export function buildEntryConfig(record, grants, { failOnStartupError = false, startupRequestTimeoutMs } = {}) {
  record = effectiveLocalRecord(record);
  if (record.transport === 'stdio') {
    const env = { ...(record.env ?? {}) };
    if (record.auth?.mode === 'oauth' && record.oauthTokenEnv) {
      const grant = record.auth.grantKey ? grants.get(record.auth.grantKey) : null;
      if (grant?.accessToken) env[record.oauthTokenEnv] = `Bearer ${grant.accessToken}`;
    }
    const guarded = startupRequestTimeoutMs !== undefined;
    if (guarded && (!Number.isSafeInteger(startupRequestTimeoutMs) || startupRequestTimeoutMs < 100 || startupRequestTimeoutMs > 2_147_483_647)) {
      throw new RangeError('stdio startup request timeout must be an integer between 100 and 2147483647 ms');
    }
    const args = cliBridgeArgs(record);
    return {
      transport: 'stdio',
      serverName: record.serverName,
      command: guarded ? process.execPath : record.command,
      args: guarded ? [STDIO_STARTUP_GUARD, '--timeout-ms', String(startupRequestTimeoutMs), '--', record.command, ...args] : args,
      env: guarded && isElectronRuntime() ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
      cwd: record.cwd || process.cwd(),
      failOnStartupError,
    };
  }
  return {
    transport: 'streamable-http',
    serverName: record.serverName,
    url: record.url,
    headers: authHeaders(record, grants),
    failOnStartupError,
  };
}

/** Keep official clients owned by this plugin; no secrets enter the Loader configuration tree. */
export async function provision(ctx, config, record, grants, options = {}) {
  const id = entryIdFor(config, record);
  const clients = ctx.mcpConnectorClients;
  const previous = clients.get(id);
  if (previous) { await previous.dispose(); clients.delete(id); }
  if (record.enabled === false) return id;
  const entryConfig = buildEntryConfig(record, grants, options);
  const fiber = ctx.plugin(McpClient, entryConfig);
  clients.set(id, fiber);
  try { await fiber; }
  catch (error) { await fiber.dispose(); if (clients.get(id) === fiber) clients.delete(id); throw error; }
  return id;
}

export async function disable(ctx, config, record) { return remove(ctx, config, record); }

export async function remove(ctx, config, record) {
  const id = entryIdFor(config, record);
  const clients = ctx.mcpConnectorClients;
  const fiber = clients.get(id);
  if (fiber) { await fiber.dispose(); if (clients.get(id) === fiber) clients.delete(id); }
  return id;
}

/** 按 serverName 判重（幂等 upsert 用） */
export function dedupeByServerName(records) {
  const seen = new Map();
  for (const record of records) {
    if (seen.has(record.serverName)) continue;
    seen.set(record.serverName, record);
  }
  return [...seen.values()];
}
