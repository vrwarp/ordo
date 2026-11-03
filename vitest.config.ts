import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
