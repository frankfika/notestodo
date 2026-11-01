import { defineConfig, devices } from '@playwright/test'

/**
 * e2e 配置：自动起 dev server（CI 里无需手动起）。
 * - reuseExistingServer：本地已开着 5173 时直接复用
 * - 断网用例（tests/offline.spec.ts）需要生产构建 + preview，dev 下自动 skip
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.SHIBEI_URL ?? 'http://127.0.0.1:5173/',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
