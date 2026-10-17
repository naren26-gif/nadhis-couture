import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000, // the dev database is remote
    fileParallelism: false,
  },
});
