/**
 * Vitest config for E2E tests.
 *
 * Separated from the default vitest config so `npm test` stays fast
 * (no Docker required). Use `npm run test:e2e` to run E2E tests.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    globalSetup: ['test/e2e/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Run E2E tests sequentially — Docker stack is shared
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
})
