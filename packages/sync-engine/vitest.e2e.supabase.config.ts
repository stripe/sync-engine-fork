/// <reference types="vitest" />
import { defineConfig } from 'vite'

// Supabase E2E tests — run via `test:e2e:supabase`
// Requires: SUPABASE_PROJECT_ID, SUPABASE_PERSONAL_ACCESS_TOKEN, STRIPE_API_KEY
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false, // sequential — each test modifies the same Supabase project
    testTimeout: 300_000, // 5 minutes — install alone can take ~60s
    hookTimeout: 120_000, // 2 minutes — beforeAll does install
    deps: {
      inline: [/.*/],
    },
    include: ['src/tests/e2e/supabase.e2e.test.ts'],
  },
})
