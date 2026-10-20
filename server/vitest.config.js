import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20000, // the dev database is remote
    hookTimeout: 60000, // some files create a lot of test data in beforeAll, over the same remote connection
    fileParallelism: false,
  },
});
