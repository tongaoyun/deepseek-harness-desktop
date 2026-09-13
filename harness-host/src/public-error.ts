const SENSITIVE_ENVIRONMENT_KEY = /(?:TOKEN|SECRET|PASSWORD|API_KEY|COOKIE|AUTHORIZATION)$/iu
const MAX_PUBLIC_ERROR_CHARACTERS = 1_000

/** Final credential boundary for errors crossing the Host process. */
export function publicErrorMessage(error: unknown, environment: NodeJS.ProcessEnv = process.env): string {
  let message = error instanceof Error ? error.message : String(error)
  const secrets = Object.entries(environment)
    .filter(([key, value]) => SENSITIVE_ENVIRONMENT_KEY.test(key) && typeof value === 'string' && value.length >= 6)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length)
  for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]')
  message = message
    .replaceAll(/sk-[A-Za-z0-9._~+/=-]{8,}/gu, '[REDACTED]')
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/giu, '$1[REDACTED]')
    .replaceAll(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/giu, '$1[REDACTED]')
  const safe = [...message].filter((character) => !/\p{Cc}/u.test(character)).join('').trim()
  return safe.slice(0, MAX_PUBLIC_ERROR_CHARACTERS) || 'Harness operation failed'
}
