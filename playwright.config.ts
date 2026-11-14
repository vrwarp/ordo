import { existsSync } from 'node:fs';
import { defineConfig, devices, webkit } from '@playwright/test';
import { SHARED_PORT } from './e2e/ports.ts';

// The shared web server's port: ORDO_E2E_PORT, else the port table's row (e2e/ports.ts, design/23 "Ports").
const PORT = SHARED_PORT;
// The iPad projects need WebKit (`npx playwright install webkit`, which CI does). Without it they are left
// out so a plain `pnpm e2e` after `playwright install chromium` still runs; ORDO_E2E_WEBKIT=1 insists.
const haveWebKit = process.env.ORDO_E2E_WEBKIT === '1' || existsSync(webkit.executablePath());
if (!haveWebKit) console.warn('playwright: WebKit is not installed; the iPad projects are skipped');
export const E2E = {
  port: PORT,
  pin: '246810',
  op: `http://op.localhost:${PORT}`,
  out: (k: number) => `http://out${k}.localhost:${PORT}`,
  stage: `http://stage.localhost:${PORT}`,
};

export default defineConfig({
  testDir: 'e2e',
  // Specs only: e2e/*.test.ts are vitest checks of the suite itself (the port table, e2e/ports.test.ts).
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.ORDO_CI ? 1 : 0,
  reporter: process.env.ORDO_CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--use-vulkan=swiftshader',
        '--enable-features=Vulkan',
        '--force-color-profile=srgb',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--use-fake-ui-for-media-stream',
        '--disable-popup-blocking',
      ],
    },
  },
  projects: [
    // The venue PC: Chromium desktop, every spec except the iPad ones.
    { name: 'chromium', testIgnore: /e2e\/ipad\// },
    // iPad editing (design/15): WebKit with the iPad Pro 11 descriptor (touch, coarse pointer), both
    // orientations. Each spec starts its own hub; the shared webServer below is not used by them.
    ...(haveWebKit
      ? [
          {
            name: 'webkit-ipad',
            testMatch: /e2e\/ipad\/.*\.spec\.ts/,
            use: { ...devices['iPad Pro 11 landscape'], launchOptions: {} },
          },
          {
            name: 'webkit-ipad-portrait',
            testMatch: /e2e\/ipad\/.*\.spec\.ts/,
            use: { ...devices['iPad Pro 11'], launchOptions: {} },
          },
        ]
      : []),
  ],
  webServer: {
    // Per-port data so concurrent runs on different ports never wipe each other's hub (not under test-results,
    // which Playwright clears at the start of a run, possibly after the hub has started).
    command: `rm -rf .e2e-data/web-${PORT} && node apps/hub/dist/main.js`,
    url: `http://localhost:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ORDO_DATA: `.e2e-data/web-${PORT}`,
      ORDO_DOMAIN: 'localhost',
      ORDO_PORT: String(PORT),
      ORDO_HOST: '127.0.0.1',
      ORDO_DEV_PIN: '246810',
      ORDO_TZ: 'UTC',
    },
  },
});
