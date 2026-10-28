/** Expert data owned by one mounted Client plugin. */
import { ExpertCatalog } from './catalog.ts'
import { ExpertTeams } from './team-cache.ts'
import type { AgencyCatalogRemote, AgencyTeamsRemote } from './remote.ts'

/** Narrow snapshot and mutation faces shared by expert UI entries. */
export interface ExpertClientState {
  readonly catalog: ExpertCatalog
  readonly teams: ExpertTeams
}

/** Create isolated expert data for a plugin instance; partial remotes support expert-only consumers.
 * @param remote Native expert Remote namespace.
 * @returns Independent catalog and team snapshots.
 */
export function createExpertClientState(remote: AgencyCatalogRemote & Partial<AgencyTeamsRemote>): ExpertClientState {
  return {
    catalog: new ExpertCatalog(remote),
    teams: new ExpertTeams({
      getTeams: (signal) => {
        if (!remote.getTeams) return Promise.reject(new Error('Expert team Remote is unavailable'))
        return remote.getTeams(signal)
      },
    }),
  }
}
