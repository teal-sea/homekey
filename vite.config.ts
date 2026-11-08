import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
// @ts-expect-error plain ESM helper without type declarations, shared with src/vercel-headers.test.ts
import { SECURITY_HEADERS } from './csp.mjs'

// ─── NAM engine assets ───
// The engine is served from /nam/ (copied there with its LICENSE and
// THIRD_PARTY_NOTICES.txt by scripts/copy-engine.mjs) and tone.ts always
// passes that as assetBaseUrl. The engine's fallback for a missing
// assetBaseUrl, `new URL('./nam-worklet.js',
// import.meta.url)` and the same for its wasm, never runs, but Vite finds the
// literals and ships a second, unused copy of both files (434 kB) into
// dist/assets. Marking the two expressions /* @vite-ignore */, Vite's own
// opt-out, stops that. If an engine upgrade changes those lines, the build
// fails here rather than quietly shipping the copy again.
const ENGINE_MODULE = '/neural-amp-modeler-wasm/dist/engine/index.js'
const ENGINE_FALLBACK_URL = /new URL\(\s*(['"]\.\/nam-(?:worklet\.js|engine\.wasm)['"])\s*,\s*import\.meta\.url\s*\)/g

function skipEngineFallbackAssets(): Plugin {
  return {
    name: 'rig:skip-engine-fallback-assets',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith(ENGINE_MODULE)) return null
      let found = 0
      const out = code.replace(ENGINE_FALLBACK_URL, (_match, url: string) => {
        found++
        return `new URL(/* @vite-ignore */ ${url}, import.meta.url)`
      })
      if (found !== 2) this.error(`expected the NAM engine's 2 fallback asset URLs, found ${found}; see vite.config.ts`)
      return { code: out, map: null }
    },
  }
}

export default defineConfig({
  plugins: [skipEngineFallbackAssets()],
  server: { headers: SECURITY_HEADERS, port: 5174 },
  preview: { headers: SECURITY_HEADERS, port: 4174 },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
