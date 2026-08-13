import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Only unit tests live here today. Kept narrow so adding a test file does
    // not accidentally pull the whole app into the run.
    include: ['src/**/*.test.{js,jsx}'],
  },
});
