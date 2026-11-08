// vercel.json is static, so it repeats the headers from csp.mjs by hand. This
// keeps the deployed policy from drifting away from the one dev, preview and
// the browser tests run under.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper without type declarations
import { SECURITY_HEADERS } from '../csp.mjs'

interface VercelConfig { headers: { source: string; headers: { key: string; value: string }[] }[] }

const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as VercelConfig

describe('vercel.json', () => {
  it('sends exactly the csp.mjs headers on every path', () => {
    const all = vercel.headers.find(h => h.source === '/(.*)')
    expect(all).toBeDefined()
    expect(Object.fromEntries((all?.headers ?? []).map(h => [h.key, h.value]))).toEqual(SECURITY_HEADERS)
  })

  it('allows WebAssembly compilation and nothing inline', () => {
    const csp = (SECURITY_HEADERS as Record<string, string>)['Content-Security-Policy']
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).not.toContain("'unsafe-inline'")
    expect(csp).not.toContain("'unsafe-eval'")
  })
})
