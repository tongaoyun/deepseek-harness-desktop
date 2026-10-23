/** Resolve an internal API path against the page base, preserving a proxy mount prefix. */
export function resolveApiUrl(path: `/api/${string}`, baseHref: string = document.baseURI): string {
  const base = new URL(baseHref)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return new URL(path.slice(1), base).href
}
