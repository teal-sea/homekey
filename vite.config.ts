import { defineConfig } from 'vitest/config'
// @ts-expect-error plain ESM helper shared with vercel.json generation and tests
import { SECURITY_HEADERS } from './csp.mjs'

export default defineConfig({
  server: { headers: SECURITY_HEADERS, port: 5174 },
  preview: { headers: SECURITY_HEADERS, port: 4174 },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
