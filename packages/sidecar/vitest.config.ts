/**
 * Default Vitest config — fast unit + integration tests, no Docker required.
 * E2E tests live in test/e2e/ and are excluded here; use `npm run test:e2e`.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
