/** Parse standard MCP JSON into an editable draft without connecting or executing commands. */
import { ConnectorDraftSchema, type ConnectorDraft } from '@deepseek-harness/product/connector-draft'
import { parse, quote } from 'shell-quote'

/** Split a complete executable command into literal argv; shell operations and expansion are rejected.
 * @param text Command entered in the MCP form.
 * @returns Executable and direct arguments without executing or interpolating them.
 */
export function connectorCommand(text: string): { command: string; arguments: string[] } {
  if (text.length > 20_000 || /[\0\r\n]/.test(text)
    || !/^(?:[^"'\\]|\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*")*$/.test(text)) throw new Error('Invalid command quoting')
  const tokens = parse(text, () => { throw new Error('Environment expansion is unsupported') })
  if (tokens.some(token => typeof token !== 'string')) throw new Error('Shell operations are unsupported')
  const argv = tokens.filter((token): token is string => typeof token === 'string')
  const command = argv.shift()
  if (!command || command.includes('=')) throw new Error('An executable is required')
  return { command, arguments: argv }
}

/** Format an executable and arguments for the complete-command input without losing quoting.
 * @param draft Connection configuration.
 * @returns Literal command text accepted by connectorCommand.
 */
export function connectorCommandText(draft: ConnectorDraft): string {
  return draft.command ? quote([draft.command, ...draft.arguments]) : ''
}

/** Read pasted private key/value rows; values remain local to the form until saving.
 * @param text JSON string map or newline-separated KEY=VALUE entries.
 * @returns Validated unique key/value entries.
 */
export function connectorVariables(text: string): Record<string, string> {
  if (text.length > 65_536) throw new Error('Variables exceed size limit')
  if (text.trim().startsWith('{')) {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Object.keys(value).length || Object.entries(value).some(([key, value]) => !key.trim() || typeof value !== 'string')) throw new Error('Invalid variables')
    return value as Record<string, string>
  }
  const entries = text.split(/\r?\n/).filter(line => line.trim()).map((line) => {
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (separator < 1 || !key) throw new Error('Invalid variable')
    return [key, line.slice(separator + 1)] as const
  })
  if (!entries.length || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate or empty variables')
  return Object.fromEntries(entries)
}

/** Read one direct server configuration or a named mcpServers map; reject unsupported transports and fields.
 * @param text Pasted MCP JSON.
 * @param draft Current connector metadata.
 * @returns Validated connection choices without executing business tools.
 */
export function connectorConfigurations(text: string, draft: ConnectorDraft): readonly ConnectorDraft[] {
  if (text.length > 65_536) throw new Error('Configuration exceeds size limit')
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected MCP configuration')
    return value as Record<string, unknown>
  }
  const parsed = object(JSON.parse(text))
  const servers = 'mcpServers' in parsed ? object(parsed.mcpServers) : { [draft.name || 'MCP']: parsed }
  if ('mcpServers' in parsed && Object.keys(parsed).some(key => key !== 'mcpServers')) throw new Error('Unsupported configuration field')
  const entries = Object.entries(servers)
  if (!entries.length || entries.length > 32) throw new Error('Select a server configuration')
  return entries.map(([name, value]) => {
    const config = object(value)
    const allowed = ['type', 'transport', 'url', 'command', 'args', 'headers', 'env', 'timeoutSeconds']
    if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('Unsupported configuration field')
    const transport = config.type ?? config.transport ?? (config.command ? 'stdio' : 'streamable-http')
    if (typeof transport !== 'string' || !['stdio', 'http', 'streamable-http'].includes(transport)
      || (config.type && config.transport && config.type !== config.transport)) {
      throw new Error('Unsupported MCP transport')
    }
    if (transport === 'stdio' ? config.url !== undefined || config.headers !== undefined : config.command !== undefined || config.args !== undefined || config.env !== undefined) {
      throw new Error('Conflicting MCP configuration')
    }
    const { oauthProviderId: _oauthProviderId, ...base } = draft
    return ConnectorDraftSchema.parse({ ...base, name, summary: draft.summary || (transport === 'stdio' ? 'STDIO MCP' : 'HTTP MCP'),
      transport: transport === 'stdio' ? 'stdio' : 'streamable-http', url: config.url,
      command: config.command, arguments: config.args ?? [], headers: config.headers ?? {}, environment: config.env ?? {},
      timeoutSeconds: config.timeoutSeconds ?? 60 })
  })
}
