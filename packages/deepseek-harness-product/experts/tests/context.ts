import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'

/** Keep real Context identity and lifecycle while substituting only the exercised services. */
export function createTestContext(services: object): Context {
  const owner = new Context()
  onTestFinished(() => owner.fiber.dispose())
  return owner.extend({ get: () => undefined, ...services })
}
