import { deadline } from '@deepseek-ai/dsh-timeout';
import { discardSkillResponse, readSkillResponse } from './response-bytes.ts';

const SEARCH_URL = "https://skills.sh/api/search";
const MAX_QUERY_LENGTH = 100;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_RESULTS = 100;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type SkillsShEntry = {
  id?: unknown;
  source?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
};

type SkillsShResponse = { skills?: unknown };

/** Validated skills.sh search entry and installation identity. */
export type SkillsShSkill = {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs?: number;
};

function catalogError(message: string, statusCode: number, code: string, options?: ErrorOptions) {
  return Object.assign(new Error(message, options), { statusCode, code });
}

function boundedString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

/** Search the fixed official endpoint and return only validated public fields.
 * @param query - Nonempty bounded search text.
 * @param fetchImpl - Host fetch transport, or the supplied transport.
 * @param signal - Caller cancellation; absent signals leave only the local deadline.
 * @returns Bounded validated search results, or a structured catalog failure.
 */
export async function searchSkillsSh(query: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<{ skills: SkillsShSkill[] }> {
  const normalized = typeof query === "string" ? query.trim() : "";
  if (!normalized || normalized.length > MAX_QUERY_LENGTH) {
    throw catalogError("搜索词不能为空且不能超过 100 个字符", 400, "error.catalog.query");
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", normalized);
  using active = deadline(signal, 10_000, 'SKILLS_CATALOG_TIMEOUT');
  active.signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: active.signal,
    });
  } catch (cause) { throw catalogError("skills.sh 搜索服务暂时不可用", 502, "error.catalog.upstream", { cause }); }
  if (!response.ok) {
    discardSkillResponse(response);
    throw catalogError("skills.sh 搜索服务暂时不可用", 502, "error.catalog.upstream");
  }
  const sizeError = catalogError("skills.sh 搜索响应过大", 502, "error.catalog.response");
  let bytes: Buffer;
  try { bytes = await readSkillResponse(response, MAX_RESPONSE_BYTES, active.signal, sizeError); }
  catch (cause) {
    if (cause === sizeError) throw cause;
    throw catalogError("skills.sh 搜索响应无效或读取中断", 502, "error.catalog.response", { cause });
  }
  const body = bytes.toString("utf8");

  let payload: SkillsShResponse;
  try {
    payload = JSON.parse(body) as SkillsShResponse;
  } catch {
    throw catalogError("skills.sh 返回了无效的搜索结果", 502, "error.catalog.response");
  }
  if (!payload || !Array.isArray(payload.skills)) {
    throw catalogError("skills.sh 返回了无效的搜索结果", 502, "error.catalog.response");
  }

  const skills: SkillsShSkill[] = [];
  const seen = new Set<string>();
  for (const candidate of payload.skills as SkillsShEntry[]) {
    if (!candidate || typeof candidate !== "object") continue;
    const source = typeof candidate.source === "string" && candidate.source.split("/").length === 2 && candidate.source.split("/").every(part => IDENTIFIER.test(part)) ? candidate.source : undefined;
    const skillId = typeof candidate.skillId === "string" && IDENTIFIER.test(candidate.skillId) ? candidate.skillId : undefined;
    const name = boundedString(candidate.name, 256);
    const id = boundedString(candidate.id, 768) || (source && skillId ? `${source}/${skillId}` : undefined);
    if (!id || !source || !skillId || !name || seen.has(id)) continue;
    const item: SkillsShSkill = { id, source, skillId, name };
    if (typeof candidate.installs === "number" && Number.isSafeInteger(candidate.installs) && candidate.installs >= 0) {
      item.installs = candidate.installs;
    }
    skills.push(item);
    seen.add(id);
    if (skills.length >= MAX_RESULTS) break;
  }
  return { skills };
}
