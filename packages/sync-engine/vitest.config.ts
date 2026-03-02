import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: true,
    testTimeout: 120000, // 2 minutes for integration tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    // Exclude E2E tests from default `vitest` command
    // These require STRIPE_API_KEY and run separately via `test:e2e`
    exclude: ['**/node_modules/**', '**/dist/**', 'src/tests/e2e/*.e2e.test.ts'],
  },
})
