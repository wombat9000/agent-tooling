import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: '.',
  testMatch: 'contract.spec.mjs',
  workers: 1,
  timeout: 15_000,
  use: { baseURL },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    cwd: process.cwd(),
    url: baseURL,
  },
});
