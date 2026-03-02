/// <reference types="vitest" />
import { defineConfig } from 'vite'

// Webhook E2E tests run sequentially to avoid Stripe webhook endpoint conflicts
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 300000,
    deps: {
      inline: [/.*/],
    },
    include: ['src/tests/e2e/webhook-*.e2e.test.ts'],
  },
})
