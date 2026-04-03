import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Service unit tests spin up Temporal's ephemeral test server in multiple files.
    // Running them one file at a time avoids flaky startup races on CI runners.
    fileParallelism: false,
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
