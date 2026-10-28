/** Typed management calls use native metadata, cancellation and structured errors. */
import type { TypertClientRemote, TypertRemoteMethod, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT_REMOTE } from './generated/typert.remote-client.js'
import type { CodedError } from './types.ts'

type GeneratedMethods = typeof TYPERT_REMOTE.methods
type Methods = { [K in keyof GeneratedMethods as K extends `skillsManager/${infer Name}` ? Name : never]: GeneratedMethods[K] }
const methods = Object.fromEntries(Object.entries(TYPERT_REMOTE.methods).map(([key, method]) => [key.slice('skillsManager/'.length), method])) as Methods
export type SkillMethod = keyof Methods
export type SkillInput<K extends SkillMethod> = Parameters<Methods[K]['invoke']>[1]
export type SkillOutput<K extends SkillMethod> = Awaited<ReturnType<Methods[K]['invoke']>> extends RemoteResult<infer T> ? T : never
export type SkillApi = <K extends SkillMethod>(method: K, input: SkillInput<K>, signal?: AbortSignal) => Promise<SkillOutput<K>>

/** Resolve the selected Session explicitly before invoking the native method.
 * @param remote Native Remote caller owned by this client composition.
 * @param sessionId Selected Session, never a global current-session singleton.
 * @returns Narrow skill operations; business failures retain their localized diagnostic code.
 */
export function createSkillApi(remote: TypertClientRemote, sessionId?: string): SkillApi {
  return async <K extends SkillMethod>(name: K, input: SkillInput<K>, signal?: AbortSignal): Promise<SkillOutput<K>> => {
    // Every method is generated as a unary invocation; this restores the indexed input/output correlation.
    const method = methods[name] as TypertRemoteMethod<SkillInput<K>, SkillOutput<K>>
    const prepared = { ...input }
    const fields: Record<string, unknown> = prepared
    const scopeFields: Partial<Record<SkillMethod, 'target' | 'request' | 'scope' | 'destination'>> = {
      readState: 'scope', readDetail: 'target', exportSkill: 'target', setSkillEnabled: 'target', setSourceEnabled: 'target',
      createCategory: 'target', renameCategory: 'target', deleteCategory: 'target', assignCategory: 'target',
      moveInCategory: 'target', setCategoryEnabled: 'target', trashSkill: 'target', restoreTrash: 'scope',
      createSkill: 'request', importSkill: 'request', uploadSkill: 'request', installCatalog: 'destination',
    }
    const key = scopeFields[name]
    if (sessionId && key && fields[key] && typeof fields[key] === 'object') {
      Object.assign(prepared, { [key]: { ...fields[key], sessionId } })
    }
    const result = await method.invoke(remote, prepared, signal)
    if (!result.ok) {
      if (result.error.code === 'skills/operation') {
        const error: CodedError = new Error(result.error.message, { cause: result.error })
        Object.assign(error, result.error.details)
        throw error
      }
      throw result.error
    }
    return result.value
  }
}
export { TYPERT_REMOTE }
