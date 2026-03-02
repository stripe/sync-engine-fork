/// <reference types="vitest" />
import { defineConfig } from 'vite'

// E2E tests that require STRIPE_API_KEY — run via `test:e2e`
// Webhook tests are excluded here and run sequentially via vitest.e2e.webhook.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: true,
    testTimeout: 120000, // 2 minutes for E2E tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    include: ['src/tests/e2e/*.e2e.test.ts'],
    exclude: ['src/tests/e2e/webhook-*.e2e.test.ts'],
  },
})
