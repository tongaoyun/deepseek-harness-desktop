import { readCatalogResponse } from './catalog-http.ts'
import { CATALOG_IDENTIFIER, catalogCount, catalogError, catalogRecord, catalogString } from './catalog-utils.ts'

export type ClawHubListOptions = { limit?: unknown; cursor?: unknown; sort?: unknown };
/** Nonnegative popularity counters returned by ClawHub. */
export type ClawHubStats = { downloads?: number; installs?: number; stars?: number };
/** Validated ClawHub identity and display metadata. */
export type ClawHubItem = { ownerHandle: string; slug: string; displayName: string; summary: string; stats?: ClawHubStats };
/** One catalog page and its next cursor. */
export type ClawHubPage = { items: ClawHubItem[]; nextCursor: string | null };

export type ClawHubSearchOptions = { limit?: unknown };
/** Search result with a ClawHub installation identity. */
export type ClawHubSearchItem = ClawHubItem & { source: "clawhub"; id?: string; downloads?: number };
/** Validated search result collection. */
export type ClawHubSearchResponse = { results: ClawHubSearchItem[] };

function skillItem(value: unknown): ClawHubItem | undefined {
  const candidate = catalogRecord(value);
  if (!candidate) return undefined;
  const owner = candidate.ownerHandle ?? catalogRecord(candidate.owner)?.handle;
  const slug = candidate.slug;
  if (typeof owner !== "string" || !CATALOG_IDENTIFIER.test(owner) || typeof slug !== "string" || !CATALOG_IDENTIFIER.test(slug)) return undefined;
  const item: ClawHubItem = {
    ownerHandle: owner, slug,
    displayName: catalogString(candidate.displayName, 256) ?? slug,
    summary: catalogString(candidate.summary, 8192) ?? "",
  };
  const stats = catalogRecord(candidate.stats) ?? catalogRecord(catalogRecord(catalogRecord(candidate.native)?.skill)?.stats);
  if (stats) {
    item.stats = {};
    for (const key of ["downloads", "installs", "stars"] as const) {
      const number = catalogCount(stats[key]);
      if (number !== undefined) item.stats[key] = number;
    }
  }
  return item;
}

/** 固定官方搜索端点，query 仅作为编码后的 q 参数。 */
export async function searchClawHub(query: string, options: ClawHubSearchOptions = {}, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ClawHubSearchResponse> {
  const normalized = typeof query === "string" ? query.trim() : "";
  if (!normalized || normalized.length > 100 || !catalogRecord(options)) throw catalogError("目录搜索参数无效", 400, "error.catalog.query");
  const limit = requestLimit(options.limit, 100);
  const url = new URL("https://clawhub.ai/api/v1/search");
  url.searchParams.set("q", normalized);
  url.searchParams.set("limit", String(limit));
  const payload = await fetchJson(url, fetchImpl, signal);
  if (!Array.isArray(payload.results)) throw catalogError("目录搜索响应无效", 502, "error.catalog.response");
  const results: ClawHubSearchItem[] = [];
  for (const value of payload.results) {
    const candidate = catalogRecord(value);
    if (!candidate || candidate.source !== undefined && candidate.source !== "clawhub") continue;
    const item = skillItem(candidate);
    if (!item) continue;
    const result: ClawHubSearchItem = { ...item, source: "clawhub" };
    if (typeof candidate.id === "string" && candidate.id && candidate.id.length <= 768) result.id = candidate.id;
    const downloads = catalogCount(candidate.downloads);
    if (downloads !== undefined) result.downloads = downloads;
    results.push(result);
    if (results.length >= limit) break;
  }
  return { results };
}

async function fetchJson(url: URL, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const bytes = await readCatalogResponse(url, fetchImpl, {
    accept: "application/json", limit: 1 << 20, timeoutMs: 10_000, signal,
    upstreamError: catalogError("ClawHub 服务暂时不可用", 502, "error.catalog.upstream"),
    responseError: catalogError("ClawHub 响应无效或过大", 502, "error.catalog.response"),
  });
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw catalogError("ClawHub 响应不是有效 JSON", 502, "error.catalog.response"); }
  const object = catalogRecord(payload);
  if (!object) throw catalogError("ClawHub 响应结构无效", 502, "error.catalog.response");
  return object;
}

function requestLimit(value: unknown, max: number) {
  if (value === undefined) return max;
  const number = typeof value === "string" && /^[0-9]{1,3}$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) throw catalogError("目录查询 limit 无效", 400, "error.catalog.query");
  return number;
}

/** 固定官方榜单端点；不接受调用方 URL。 */
export async function listClawHub(options: ClawHubListOptions = {}, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<ClawHubPage> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw catalogError("目录查询参数无效", 400, "error.catalog.query");
  const limit = requestLimit(options.limit, 10);
  const sort = options.sort === undefined ? "downloads" : options.sort;
  if (sort !== "downloads") throw catalogError("目录榜单排序无效", 400, "error.catalog.query");
  if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > 4096)) throw catalogError("目录分页标识无效", 400, "error.catalog.query");
  const url = new URL("https://clawhub.ai/api/v1/skills");
  url.searchParams.set("sort", sort);
  url.searchParams.set("limit", String(limit));
  if (options.cursor !== undefined) url.searchParams.set("cursor", options.cursor);
  const payload = await fetchJson(url, fetchImpl, signal);
  if (!Array.isArray(payload.items)) throw catalogError("目录榜单响应无效", 502, "error.catalog.response");
  const nextCursor = payload.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length > 4096)) throw catalogError("目录分页响应无效", 502, "error.catalog.response");
  const items: ClawHubItem[] = [];
  for (const value of payload.items) {
    const item = skillItem(value);
    if (!item) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return { items, nextCursor: typeof nextCursor === "string" && nextCursor ? nextCursor : null };
}
