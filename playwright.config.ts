// Browser tests run against the production build served by `vite preview`,
// which sends the same CSP headers as the deployment (csp.mjs), so a CSP
// violation fails here before it fails for a player.
//
// Chromium only for M1. Its fake media device stands in for the guitar: it
// plays a short periodic beep, enough to move the meter, light a note and put
// sound in a take.

/// <reference types="node" />
import { chromium, defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'

// One free-ish port per run, shared with the workers through the environment
// (workers re-read this file; reading the variable keeps them on the same port).
process.env.RIG_E2E_PORT ??= String(20000 + Math.floor(Math.random() * 20000))
const port = Number(process.env.RIG_E2E_PORT)

// Playwright's own Chromium (`npx playwright install chromium`) when it is there.
// Otherwise CHROMIUM_PATH, or a `chromium` link in PLAYWRIGHT_BROWSERS_PATH: a
// prebuilt image can carry a newer Chromium than this Playwright version expects.
function chromiumExecutable(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return undefined
  const shared = process.env.PLAYWRIGHT_BROWSERS_PATH ? path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium') : null
  return shared && existsSync(shared) ? shared : undefined
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    acceptDownloads: true,
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        executablePath: chromiumExecutable(),
        args: [
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ],
      },
    },
  }],
  webServer: {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
