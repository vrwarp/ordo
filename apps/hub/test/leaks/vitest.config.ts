import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The child run of `tempdirs.test.ts`: only the case files here (never part of the hub's own run).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.case.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
