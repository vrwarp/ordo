import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
      'tools/**/*.test.ts',
      // The e2e suite's own checks (its port table); the Playwright specs are *.spec.ts.
      'e2e/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
  },
});
