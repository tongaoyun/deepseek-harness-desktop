import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../generated/typert.remote-client.js'

export { TYPERT_REMOTE, TYPERT_REMOTE as default } from '../remote-contract.ts'

type AgencyAgentsRemote = TypertRemoteNamespaceMap['agencyAgents']
/** Catalog calls derived from the actual Host Remote methods. */
export type AgencyCatalogRemote = Pick<AgencyAgentsRemote, 'getCatalog' | 'getCustomExpert' | 'saveCustomExpert' | 'deleteCustomExpert'>
/** Team calls derived from the actual Host Remote methods. */
export type AgencyTeamsRemote = Pick<AgencyAgentsRemote, 'exportTeam' | 'getTeams' | 'saveTeam' | 'setTeamEnabled' | 'deleteTeam'>
type RemoteValue<Call extends (...args: never[]) => Promise<RemoteResult<unknown>>> =
  Awaited<ReturnType<Call>> extends RemoteResult<infer Value> ? Value : never
/** Saved selection returned by the native Remote. */
export type AgencyAgentsEnabledState = RemoteValue<AgencyAgentsRemote['getEnabled']>
