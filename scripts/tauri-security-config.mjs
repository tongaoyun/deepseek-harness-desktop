import { loadEnv } from 'vite'

const DEFAULT_SERVER_URL = 'http://192.168.2.67:30081'

export function resolveTauriServerUrl(command, cwd = process.cwd(), environment = process.env) {
  const configured = environment.VITE_XIAOYIN_SERVER_URL
    ?? loadEnv(command === 'dev' ? 'development' : 'production', cwd, 'VITE_').VITE_XIAOYIN_SERVER_URL
  const value = configured || DEFAULT_SERVER_URL
  const parsed = parseServerUrl(value)
  if (command === 'build' && parsed.protocol === 'http:' && !isPrivateNetworkHost(parsed.hostname)) {
    throw new Error('Release builds allow HTTP only for loopback or RFC1918 private network servers')
  }
  return value
}

export function tauriSecurityConfig(serverUrl = DEFAULT_SERVER_URL) {
  let origin
  try {
    const parsed = parseServerUrl(serverUrl)
    origin = parsed.origin
  } catch {
    throw new Error('VITE_XIAOYIN_SERVER_URL must be an absolute HTTP(S) URL')
  }
  const connectSources = [
    "'self'",
    'http://127.0.0.1:8080',
    DEFAULT_SERVER_URL,
    'http://192.168.2.67:32000',
    origin,
  ].filter((value, index, all) => all.indexOf(value) === index)
  return {
    app: {
      security: {
        csp: `default-src 'self'; connect-src ${connectSources.join(' ')}; frame-src https://login.dingtalk.com blob: http://127.0.0.1:*; img-src 'self' asset: http://asset.localhost data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'`,
      },
    },
  }
}

function parseServerUrl(value) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsupported server URL')
  return parsed
}

function isPrivateNetworkHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 192 && octets[1] === 168
    || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31
}

export { DEFAULT_SERVER_URL }
