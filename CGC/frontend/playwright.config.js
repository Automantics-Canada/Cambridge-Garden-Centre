import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { backendQaEnv, frontendQaEnv } from './e2e/qa-env.js';

const frontend = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(frontend, '../backend');
const artifacts = path.resolve(frontend, '../../.codex/artifacts/playwright');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  outputDir: path.join(artifacts, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(artifacts, 'html-report'), open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      // Reset and seed before opening the Prisma client in the API process.
      // On Windows, generating while that DLL is loaded fails with EPERM.
      command: 'npm run qa:prepare && npm run dev:e2e',
      cwd: backend,
      env: backendQaEnv,
      url: 'http://127.0.0.1:4000/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run preview:e2e',
      cwd: frontend,
      env: frontendQaEnv,
      url: 'http://127.0.0.1:5173/login',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'desktop-staff',
      testMatch: /staff\.spec\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-driver',
      testMatch: /driver\.spec\.js/,
      dependencies: ['desktop-staff'],
      use: { ...devices['Pixel 7'] },
    },
  ],
});
