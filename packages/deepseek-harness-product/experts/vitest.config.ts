import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../../vitest.shared.ts'

export default defineConfig({ plugins: [standardDecoratorPlugin(), tsconfigPaths({ projects: ['./tsconfig.base.json'] })], test: { include: ['packages/deepseek-harness-product/experts/src/**/*.test.{ts,tsx}', 'packages/deepseek-harness-product/experts/tests/**/*.test.{ts,tsx}'] } })
