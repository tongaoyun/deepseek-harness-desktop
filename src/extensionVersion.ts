import packageJson from '../package.json'

export const desktopVersion = packageJson.version

/** Compare release versions without accepting an invalid catalog value. */
export function compareDesktopVersions(left: string, right: string): number | undefined {
  const parse = (value: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value.trim())
    if (!match) return undefined
    const major = Number(match[1]), minor = Number(match[2]), patch = Number(match[3])
    if (![major, minor, patch].every(Number.isSafeInteger)) return undefined
    return { major, minor, patch, prerelease: match[4]?.split('.') }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) return undefined
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (!a.prerelease && !b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const first = a.prerelease[index], second = b.prerelease[index]
    if (first === undefined) return -1
    if (second === undefined) return 1
    if (first === second) continue
    const firstNumeric = /^\d+$/u.test(first), secondNumeric = /^\d+$/u.test(second)
    if (firstNumeric && secondNumeric) return BigInt(first) > BigInt(second) ? 1 : -1
    if (firstNumeric !== secondNumeric) return firstNumeric ? -1 : 1
    return first > second ? 1 : -1
  }
  return 0
}

export function isDesktopVersionCompatible(minimum: string | undefined): boolean {
  if (!minimum?.trim()) return true
  const comparison = compareDesktopVersions(desktopVersion, minimum)
  return comparison !== undefined && comparison >= 0
}

export function versionRequirement(minimum: string | undefined): string {
  return minimum?.trim() ? `需要小胤 ${minimum} 或更高版本` : ''
}
