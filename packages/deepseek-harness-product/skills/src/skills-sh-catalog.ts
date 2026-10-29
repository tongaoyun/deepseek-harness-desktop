import { readCatalogResponse } from './catalog-http.ts'
import { CATALOG_IDENTIFIER, catalogCount, catalogError, catalogString } from './catalog-utils.ts'

const SEARCH_URL = "https://skills.sh/api/search";
const MAX_QUERY_LENGTH = 100;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_RESULTS = 100;

type SkillsShEntry = {
  id?: unknown;
  source?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
};

type SkillsShResponse = { skills?: unknown };

/** Validated skills.sh source, skill identity, and display metadata. */
export type SkillsShSkill = {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs?: number;
};

/** 通过固定的官方搜索端点查询目录，并只向本地客户端返回受校验字段。 */
export async function searchSkillsSh(query: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<{ skills: SkillsShSkill[] }> {
  const normalized = typeof query === "string" ? query.trim() : "";
  if (!normalized || normalized.length > MAX_QUERY_LENGTH) {
    throw catalogError("搜索词不能为空且不能超过 100 个字符", 400, "error.catalog.query");
  }

  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", normalized);
  const bytes = await readCatalogResponse(url, fetchImpl, {
    accept: "application/json", limit: MAX_RESPONSE_BYTES, timeoutMs: 10_000, signal,
    upstreamError: catalogError("skills.sh 搜索服务暂时不可用", 502, "error.catalog.upstream"),
    responseError: catalogError("skills.sh 搜索响应无效或过大", 502, "error.catalog.response"),
  });
  const body = Buffer.from(bytes).toString("utf8");

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
    const source = typeof candidate.source === "string" && candidate.source.split("/").length === 2 && candidate.source.split("/").every(part => CATALOG_IDENTIFIER.test(part)) ? candidate.source : undefined;
    const skillId = typeof candidate.skillId === "string" && CATALOG_IDENTIFIER.test(candidate.skillId) ? candidate.skillId : undefined;
    const name = catalogString(candidate.name, 256);
    const id = catalogString(candidate.id, 768) || (source && skillId ? `${source}/${skillId}` : undefined);
    if (!id || !source || !skillId || !name || seen.has(id)) continue;
    const item: SkillsShSkill = { id, source, skillId, name };
    const installs = catalogCount(candidate.installs)
    if (installs !== undefined) item.installs = installs
    skills.push(item);
    seen.add(id);
    if (skills.length >= MAX_RESULTS) break;
  }
  return { skills };
}
