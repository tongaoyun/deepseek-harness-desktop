/** Native credential storage with a read-only, process-owned company model key. */
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { ProductError } from '@deepseek-harness/product/errors'

const COMPANY_KEY = 'DSH_PRODUCT_MODEL_API_KEY'

/** Preserve native personal credentials and grants; company authentication comes from desktop sign-in. */
export default class ProductCredentials extends LocalCredentialProvider {
  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    if (ref !== COMPANY_KEY) return super.resolve(ref)
    const key = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])?.value
    return Promise.resolve(key ? { value: key, source: 'env' } : undefined)
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    if (ref !== COMPANY_KEY) return super.describe(ref)
    const key = await this.resolve(ref)
    return { configured: key !== undefined, writable: false, ...key === undefined ? {} : { source: key.source } }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (ref === COMPANY_KEY) throw this.managedKeyError()
    await super.set(ref, value)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (ref === COMPANY_KEY) throw this.managedKeyError()
    await super.unset(ref)
  }

  private managedKeyError(): ProductError {
    return new ProductError('PRODUCT_CREDENTIAL_MANAGED', '公司模型密钥由钉钉登录管理，请重启桌面端并重新登录。')
  }
}
