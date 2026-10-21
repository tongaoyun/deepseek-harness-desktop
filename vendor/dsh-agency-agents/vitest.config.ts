import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

export default defineConfig({ plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })], test: { include: ['vendor/dsh-agency-agents/src/**/*.test.{ts,tsx}'] } })
