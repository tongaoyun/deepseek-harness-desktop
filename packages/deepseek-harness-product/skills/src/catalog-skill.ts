import { deadline } from '@deepseek-ai/dsh-timeout';
import { discardSkillResponse, readSkillResponse } from './response-bytes.ts';
import { parseSkillDoc } from "./core.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const MAX_TEXT_BYTES = 1 << 20;
const MAX_ARCHIVE_BYTES = 8 << 20;
const MAX_FILES = 100;

type CatalogRequest = { catalog?: unknown; owner?: unknown; slug?: unknown; source?: unknown; skillId?: unknown };

/** Exact public catalog identity validated before download. */
export type CatalogIdentity =
  | { catalog: "clawhub"; owner: string; slug: string }
  | { catalog: "skillsh"; source: string; skillId: string };

export type CatalogDetail = { name: string; description: string; body: string; origin: string };
export type CatalogPackage = { name: string; zip?: string; entries?: { path: string; data: string }[] };

type FetchLike = typeof fetch;

function catalogError(message: string, statusCode: number, code: string, options?: ErrorOptions) {
  return Object.assign(new Error(message, options), { statusCode, code });
}

function identifier(value: unknown) {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}

function skillshParts(input: { source?: unknown; skillId?: unknown }) {
  const source = typeof input.source === "string" ? input.source : "";
  const [owner, repo, extra] = source.split("/");
  const skillId = identifier(input.skillId);
  if (!identifier(owner) || !identifier(repo) || extra !== undefined || !skillId) return undefined;
  return { owner: owner!, repo: repo!, skillId, source };
}

/** 只构造两个目录的固定官方地址，调用方不能传入 URL。 */
export function catalogUrls(input: CatalogRequest) {
  if (!input || input.catalog === "clawhub") {
    const owner = identifier(input?.owner);
    const slug = identifier(input?.slug);
    if (input?.catalog !== "clawhub" || !owner || !slug) throw catalogError("目录技能标识无效", 400, "error.catalog.identity");
    const detail = new URL(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}/file`);
    detail.searchParams.set("path", "SKILL.md");
    detail.searchParams.set("owner", owner);
    const download = new URL("https://clawhub.ai/api/v1/download");
    download.searchParams.set("slug", slug);
    download.searchParams.set("owner", owner);
    return { detail: detail.toString(), download: download.toString(), origin: `${owner}/${slug}` };
  }
  if (input.catalog === "skillsh") {
    const parts = skillshParts(input);
    if (!parts) throw catalogError("目录技能标识无效", 400, "error.catalog.identity");
    const download = `https://skills.sh/api/download/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/${encodeURIComponent(parts.skillId)}`;
    return { detail: download, download, origin: `${parts.source}/${parts.skillId}` };
  }
  throw catalogError("目录技能标识无效", 400, "error.catalog.identity");
}

function parseFilesJson(bytes: Uint8Array) {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw catalogError("目录技能返回了无效 JSON", 502, "error.catalog.response");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw catalogError("目录技能文件无效", 502, "error.catalog.response");
  const files = (payload as { files?: unknown }).files;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw catalogError("目录技能文件无效或过多", 502, "error.catalog.response");
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file) || typeof file.path !== "string" || typeof file.contents !== "string") throw catalogError("目录技能文件无效", 502, "error.catalog.response");
  }
  return { files: files as { path: string; contents: string }[] };
}

function skillDocSummary(markdown: string) {
  const parsed = parseSkillDoc(markdown);
  const name = parsed.map.name?.trim();
  const description = parsed.map.description?.trim();
  return { name, description, body: parsed.body };
}

async function fetchFixed(url: string, fetchImpl: FetchLike, accept: string, limit: number, signal?: AbortSignal) {
  using active = deadline(signal, 15_000, 'SKILLS_CATALOG_TIMEOUT');
  active.signal.throwIfAborted();
  let response: Response;
  try { response = await fetchImpl(url, { headers: { accept }, redirect: "error", signal: active.signal }); }
  catch (cause) { throw catalogError("目录技能暂时无法读取", 502, "error.catalog.upstream", { cause }); }
  if (!response.ok) {
    discardSkillResponse(response);
    throw catalogError("目录技能暂时无法读取", 502, "error.catalog.upstream");
  }
  const sizeError = catalogError("目录技能内容过大", 502, "error.catalog.response");
  try { return await readSkillResponse(response, limit, active.signal, sizeError); }
  catch (cause) {
    if (cause === sizeError) throw cause;
    throw catalogError("目录技能响应无效或读取中断", 502, "error.catalog.response", { cause });
  }
}

/** Read one fixed catalog document under the request lifetime and a local deadline.
 * @param input - Validated catalog identity; arbitrary URLs are not accepted.
 * @param fetchImpl - Fetch transport, defaulting to the Host's fetch.
 * @param signal - Caller cancellation; when absent only the local deadline applies.
 * @returns Complete validated metadata and body, or a catalog operation failure.
 */
export async function readCatalogSkill(input: CatalogRequest, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<CatalogDetail> {
  const urls = catalogUrls(input);
  if (input.catalog === "clawhub") {
    const bytes = await fetchFixed(urls.detail, fetchImpl, "text/markdown, text/plain", MAX_TEXT_BYTES, signal);
    const markdown = new TextDecoder().decode(bytes);
    const parsed = skillDocSummary(markdown);
    if (!parsed.name || !parsed.description) throw catalogError("目录技能说明无效", 502, "error.catalog.response");
    return { name: parsed.name, description: parsed.description, body: parsed.body, origin: urls.origin };
  }
  const payload = parseFilesJson(await fetchFixed(urls.download, fetchImpl, "application/json", MAX_TEXT_BYTES, signal));
  const document = payload.files?.find(file => file.path === "SKILL.md" && typeof file.contents === "string");
  if (!document || typeof document.contents !== "string") throw catalogError("目录技能说明无效", 502, "error.catalog.response");
  const parsed = skillDocSummary(document.contents);
  if (!parsed.name || !parsed.description) throw catalogError("目录技能说明无效", 502, "error.catalog.response");
  return { name: parsed.name, description: parsed.description, body: parsed.body, origin: urls.origin };
}

/** Download complete installable content without accepting truncated archives.
 * @param input - Fixed public catalog identity.
 * @param fetchImpl - Fetch transport, defaulting to the Host's fetch.
 * @param signal - Caller cancellation; when absent only each download's local deadline applies.
 * @returns Complete package bytes or files; failures do not install content.
 */
export async function loadCatalogPackage(input: CatalogRequest, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<CatalogPackage> {
  const urls = catalogUrls(input);
  if (input.catalog === "clawhub") {
    const bytes = await fetchFixed(urls.download, fetchImpl, "application/zip", MAX_ARCHIVE_BYTES, signal);
    const detail = await readCatalogSkill(input, fetchImpl, signal);
    return { name: detail.name, zip: Buffer.from(bytes).toString("base64") };
  }
  const payload = parseFilesJson(await fetchFixed(urls.download, fetchImpl, "application/json", MAX_ARCHIVE_BYTES, signal));
  if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > MAX_FILES) throw catalogError("目录技能文件无效或过多", 502, "error.catalog.response");
  const entries = payload.files.map(file => {
    if (typeof file.path !== "string" || !SAFE_PATH.test(file.path) || typeof file.contents !== "string") throw catalogError("目录技能包含非法文件路径", 502, "error.catalog.response");
    return { path: file.path, data: Buffer.from(file.contents, "utf8").toString("base64") };
  });
  if (!entries.some(entry => entry.path === "SKILL.md")) throw catalogError("目录技能缺少 SKILL.md", 502, "error.catalog.response");
  const detail = skillDocSummary(Buffer.from(entries.find(entry => entry.path === "SKILL.md")!.data, "base64").toString("utf8"));
  if (!detail.name) throw catalogError("目录技能说明无效", 502, "error.catalog.response");
  return { name: detail.name, entries };
}
