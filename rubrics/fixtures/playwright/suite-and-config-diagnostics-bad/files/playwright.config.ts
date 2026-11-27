import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  retries: 4,
  timeout: 300_000,
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});
