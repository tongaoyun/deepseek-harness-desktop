import { loadEnv } from 'vite'

const DEFAULT_SERVER_URL = 'http://192.168.2.67:30081'

export function resolveTauriServerUrl(command, cwd = process.cwd(), environment = process.env) {
  const configured = environment.VITE_XIAOYIN_SERVER_URL
    ?? loadEnv(command === 'dev' ? 'development' : 'production', cwd, 'VITE_').VITE_XIAOYIN_SERVER_URL
  const value = configured || DEFAULT_SERVER_URL
  if (command === 'build' && new URL(value).protocol !== 'https:') {
    throw new Error('Release builds require an HTTPS VITE_XIAOYIN_SERVER_URL')
  }
  return value
}

export function tauriSecurityConfig(serverUrl = DEFAULT_SERVER_URL) {
  let origin
  try {
    const parsed = new URL(serverUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol')
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

export { DEFAULT_SERVER_URL }
