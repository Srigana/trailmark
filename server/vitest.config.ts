import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
